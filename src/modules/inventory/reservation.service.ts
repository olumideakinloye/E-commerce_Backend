import mongoose, { Types, type ClientSession } from 'mongoose';
import { Inventory } from './models/inventory.model.js';
import { Reservation } from './models/reservation.model.js';
import { UnprocessableEntityError } from '@common/errors.js';
import { env } from '@config/env.js';

export const RESERVATION_TTL_MS = (env?.RESERVATION_TTL_MINUTES ?? 15) * 60 * 1000;

export interface ReservationItem {
  productId: string | Types.ObjectId;
  qty: number;
}

/**
 * Low-level transactional reservation execution within an existing MongoDB ClientSession.
 *
 * Scenario A — overselling prevention:
 * Each product's inventory is updated with a conditional update:
 *   { $inc: { reserved: qty } } WHERE (onHand - reserved) >= qty
 * This means no two concurrent requests can both "see" enough stock —
 * the second will fail the condition check and throw an error.
 *
 * Items are deterministically sorted by productId before reserving
 * to avoid MongoDB write-conflict deadlock patterns across concurrent multi-item transactions.
 */
export async function reserveStockInSession(
  orderId: Types.ObjectId,
  items: ReservationItem[],
  session: ClientSession,
  customTtlMs?: number,
): Promise<void> {
  const ttlMs = customTtlMs ?? RESERVATION_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);

  // Deterministically sort items by string representation of productId to avoid deadlocks
  const sortedItems = [...items].sort((a, b) =>
    String(a.productId).localeCompare(String(b.productId)),
  );

  // Phase 1: Conditionally increment reserved for each product in deterministic order
  for (const item of sortedItems) {
    const pId =
      typeof item.productId === 'string' ? new Types.ObjectId(item.productId) : item.productId;

    const updated = await Inventory.findOneAndUpdate(
      {
        productId: pId,
        // The atomic guard: only succeeds if available (onHand - reserved) >= qty
        $expr: { $gte: [{ $subtract: ['$onHand', '$reserved'] }, item.qty] },
      },
      { $inc: { reserved: item.qty } },
      { session, returnDocument: 'after' },
    );

    if (!updated) {
      // Not enough stock — abort transaction, rolling back everything
      throw new UnprocessableEntityError(`Insufficient stock for product ${pId.toString()}`);
    }
  }

  // Phase 2: Create the Reservation record
  await Reservation.create(
    [
      {
        orderId,
        items: items.map((i) => ({
          productId:
            typeof i.productId === 'string' ? new Types.ObjectId(i.productId) : i.productId,
          qty: i.qty,
        })),
        status: 'ACTIVE',
        expiresAt,
      },
    ],
    { session },
  );
}

/**
 * Atomically reserve stock for all items in a single MongoDB transaction.
 * Creates its own session and commits or aborts.
 */
export async function reserveStock(
  orderId: string | Types.ObjectId,
  items: ReservationItem[],
  customTtlMs?: number,
): Promise<string> {
  const oId = typeof orderId === 'string' ? new Types.ObjectId(orderId) : orderId;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await reserveStockInSession(oId, items, session, customTtlMs);
    });
  } finally {
    await session.endSession();
  }

  return oId.toString();
}

/**
 * Commit reservation within an existing session.
 */
export async function commitReservationInSession(
  orderId: Types.ObjectId,
  session: ClientSession,
): Promise<void> {
  const reservation = await Reservation.findOneAndUpdate(
    { orderId, status: 'ACTIVE' },
    { $set: { status: 'COMMITTED' } },
    { session, returnDocument: 'after' },
  );

  if (!reservation) {
    throw new UnprocessableEntityError('No active reservation found for this order');
  }

  await Promise.all(
    reservation.items.map((item) =>
      Inventory.updateOne(
        { productId: item.productId },
        { $inc: { onHand: -item.qty, reserved: -item.qty } },
        { session },
      ),
    ),
  );
}

/**
 * Commit a reservation after successful payment.
 * Guarded by atomic CAS: { orderId, status: 'ACTIVE' } -> status: 'COMMITTED'.
 * Decrements onHand and reserved by the reserved amounts.
 */
export async function commitReservation(orderId: string | Types.ObjectId): Promise<void> {
  const oId = typeof orderId === 'string' ? new Types.ObjectId(orderId) : orderId;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await commitReservationInSession(oId, session);
    });
  } finally {
    await session.endSession();
  }
}

/**
 * Release reservation within an existing session.
 */
export async function releaseReservationInSession(
  orderId: Types.ObjectId,
  session: ClientSession,
): Promise<void> {
  const reservation = await Reservation.findOneAndUpdate(
    {
      orderId,
      status: 'ACTIVE',
    },
    { $set: { status: 'RELEASED' } },
    { session, returnDocument: 'after' },
  );

  if (!reservation) return; // already released, committed, or expired — idempotent

  await Promise.all(
    reservation.items.map((item) =>
      Inventory.updateOne(
        { productId: item.productId },
        { $inc: { reserved: -item.qty } },
        { session },
      ),
    ),
  );
}

/**
 * Release a reservation (order cancelled or payment failed).
 * Guarded by atomic CAS: { orderId, status: 'ACTIVE' } -> status: 'RELEASED'.
 * Decrements only the reserved counter — stock returns to available pool.
 * Idempotent: does nothing if already released, committed, or expired.
 */
export async function releaseReservation(orderId: string | Types.ObjectId): Promise<void> {
  const oId = typeof orderId === 'string' ? new Types.ObjectId(orderId) : orderId;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await releaseReservationInSession(oId, session);
    });
  } finally {
    await session.endSession();
  }
}

/**
 * Scenario F — Reservation sweeper.
 * Called by a background job / scheduler to expire reservations past their TTL.
 * Uses a cursor to process in batches to avoid memory/time blowout.
 * Guarded by atomic CAS: { _id, status: 'ACTIVE', expiresAt: < now } -> status: 'EXPIRED'.
 */
export async function sweepExpiredReservations(batchSize = 100): Promise<number> {
  const now = new Date();
  let totalExpired = 0;

  // Use a cursor to stream expired items without loading everything into memory
  const cursor = Reservation.find({
    status: 'ACTIVE',
    expiresAt: { $lt: now },
  }).cursor();

  for await (const reservation of cursor) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Atomic CAS inside transaction
        const locked = await Reservation.findOneAndUpdate(
          {
            _id: reservation._id,
            status: 'ACTIVE',
            expiresAt: { $lt: now },
          },
          { $set: { status: 'EXPIRED' } },
          { session, returnDocument: 'after' },
        );

        if (!locked) return; // Already claimed or processed by another worker

        await Promise.all(
          locked.items.map((item) =>
            Inventory.updateOne(
              { productId: item.productId },
              { $inc: { reserved: -item.qty } },
              { session },
            ),
          ),
        );

        totalExpired++;
      });
    } finally {
      await session.endSession();
    }

    if (totalExpired >= batchSize) break;
  }

  return totalExpired;
}

/**
 * Expire a single reservation by orderId.
 * Used by delayed queue jobs.
 * Guarded by atomic CAS: status='ACTIVE' and expiresAt <= now.
 */
export async function expireSingleReservation(orderId: string | Types.ObjectId): Promise<boolean> {
  const oId = typeof orderId === 'string' ? new Types.ObjectId(orderId) : orderId;
  const now = new Date();
  let expired = false;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const locked = await Reservation.findOneAndUpdate(
        {
          orderId: oId,
          status: 'ACTIVE',
          expiresAt: { $lte: now },
        },
        { $set: { status: 'EXPIRED' } },
        { session, returnDocument: 'after' },
      );

      if (!locked) return;

      await Promise.all(
        locked.items.map((item) =>
          Inventory.updateOne(
            { productId: item.productId },
            { $inc: { reserved: -item.qty } },
            { session },
          ),
        ),
      );

      expired = true;
    });
  } finally {
    await session.endSession();
  }

  return expired;
}
