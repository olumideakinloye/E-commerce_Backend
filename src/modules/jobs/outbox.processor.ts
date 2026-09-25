/**
 * Outbox Dispatcher Worker
 *
 * Implements the "claim with lease" pattern to safely distribute outbox event
 * processing across multiple worker instances without double-processing.
 *
 * Flow per poll tick:
 *  1. Atomically claim up to BATCH_SIZE PENDING/FAILED rows whose nextAttemptAt
 *     is due and whose lockedUntil is expired (or null), by setting lockedUntil
 *     to now + LOCK_TTL_MS.
 *  2. Dispatch each event to its typed handler.
 *  3. Mark the row COMPLETED — or, on failure, increment attempts, set lastError,
 *     and advance nextAttemptAt with exponential backoff. If attempts >= maxAttempts
 *     mark it FAILED permanently.
 *
 * Graceful shutdown: call stop() and await the returned Promise.
 */

import { Outbox, type OutboxDoc } from './models/outbox.model.js';
import { clearUserCart } from '@modules/cart/cart.service.js';
import { getPaymentProvider } from '@modules/payments/providers/index.js';
import { Order } from '@modules/orders/models/order.model.js';
import { Payment } from '@modules/payments/models/payment.model.js';
import { releaseReservationInSession } from '@modules/inventory/reservation.service.js';
import mongoose from 'mongoose';
import { logger } from '@common/logger.js';

// ─── Configuration ────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 5_000; // how often to poll for work
const LOCK_TTL_MS = 30_000; // how long a lease is held before another worker may steal it
const BATCH_SIZE = 10; // rows per poll tick
const BASE_BACKOFF_MS = 1_000; // initial retry delay
const MAX_BACKOFF_MS = 300_000; // cap at 5 minutes

// ─── Typed payload shapes ─────────────────────────────────────────────────────
interface InitiatePaymentPayload {
  orderId: string;
  paymentRef: string;
  amountMinor: number;
  currency: string;
  provider: string;
}

interface ClearCartPayload {
  userId: string;
}

// ─── Event handlers ───────────────────────────────────────────────────────────

/**
 * INITIATE_PAYMENT — calls the payment provider to initialise the transaction.
 *
 * On failure (gateway error or too many attempts) the order is moved to
 * PAYMENT_FAILED and the reservation is released as a compensating action.
 */
async function handleInitiatePayment(payload: InitiatePaymentPayload): Promise<void> {
  const { orderId, paymentRef, amountMinor, currency, provider: providerName } = payload;

  try {
    const order = await Order.findById(orderId);
    const payment = await Payment.findOne({ reference: paymentRef });

    if (!order || !payment) {
      logger.warn(
        { orderId, paymentRef },
        'INITIATE_PAYMENT: order or payment not found; skipping',
      );
      return;
    }

    // Only attempt if order is still in PENDING_PAYMENT
    if (order.status !== 'PENDING_PAYMENT') {
      logger.info(
        { orderId, orderStatus: order.status },
        'INITIATE_PAYMENT: order already transitioned; skipping',
      );
      return;
    }

    const provider = getPaymentProvider(providerName);
    const result = await provider.initialize({
      orderId,
      reference: paymentRef,
      amountMinor,
      currency,
    });

    // Store the authorization URL on the Payment record for client retrieval
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { authorizationUrl: result.authorizationUrl } },
    );

    logger.info(
      { orderId, paymentRef, provider: providerName, authorizationUrl: result.authorizationUrl },
      'Payment initialised successfully',
    );
  } catch (err) {
    logger.error({ err, orderId, paymentRef }, 'INITIATE_PAYMENT handler failed');
    throw err; // let the caller handle retry / dead-letter
  }
}

/**
 * INITIATE_PAYMENT compensating action — called when the event has exhausted
 * its retries. Marks the order PAYMENT_FAILED and releases reserved inventory.
 */
async function compensateInitiatePayment(payload: InitiatePaymentPayload): Promise<void> {
  const { orderId } = payload;
  logger.warn({ orderId }, 'INITIATE_PAYMENT exhausted retries — compensating (PAYMENT_FAILED)');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const updated = await Order.findOneAndUpdate(
        { _id: orderId, status: 'PENDING_PAYMENT' },
        { $set: { status: 'PAYMENT_FAILED' } },
        { session, returnDocument: 'after' },
      );

      await Payment.updateOne(
        { orderId, status: 'INITIATED' },
        { $set: { status: 'FAILED' } },
        { session },
      );

      if (updated) {
        await releaseReservationInSession(new mongoose.Types.ObjectId(orderId), session);
      }
    });
  } finally {
    await session.endSession();
  }
}

/**
 * CLEAR_CART — best-effort cart clear after successful checkout commit.
 * This is intentionally non-critical: if it fails a few times and gives up,
 * the cart just lingers until the user or TTL index clears it.
 */
async function handleClearCart(payload: ClearCartPayload): Promise<void> {
  await clearUserCart(payload.userId);
  logger.info({ userId: payload.userId }, 'Cart cleared via outbox event');
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

async function dispatch(event: OutboxDoc): Promise<void> {
  const payload = event.payload as Record<string, unknown>;

  switch (event.type) {
    case 'INITIATE_PAYMENT':
      await handleInitiatePayment(payload as unknown as InitiatePaymentPayload);
      break;

    case 'CLEAR_CART':
      await handleClearCart(payload as unknown as ClearCartPayload);
      break;

    default:
      logger.warn({ type: event.type }, 'Unknown outbox event type; marking ignored');
      // treat as permanent failure so it doesn't loop forever
      throw new Error(`Unknown outbox event type: ${event.type}`);
  }
}

// ─── Core polling loop ────────────────────────────────────────────────────────

async function processBatch(): Promise<void> {
  const now = new Date();
  const lockUntil = new Date(now.getTime() + LOCK_TTL_MS);

  // Claim up to BATCH_SIZE rows atomically using findOneAndUpdate in a loop.
  // (findOneAndUpdate is atomic at the document level.)
  const claimed: OutboxDoc[] = [];

  for (let i = 0; i < BATCH_SIZE; i++) {
    const row = await Outbox.findOneAndUpdate(
      {
        status: { $in: ['PENDING', 'PROCESSING'] },
        nextAttemptAt: { $lte: now },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
        $expr: { $lt: ['$attempts', '$maxAttempts'] },
      } as Record<string, unknown>,
      {
        $set: { status: 'PROCESSING', lockedUntil: lockUntil },
        $inc: { attempts: 1 },
      },
      { returnDocument: 'after' },
    );

    if (!row) break; // no more eligible rows
    claimed.push(row);
  }

  if (claimed.length === 0) return;

  logger.debug({ count: claimed.length }, 'Outbox: claimed batch');

  await Promise.allSettled(
    claimed.map(async (event) => {
      try {
        await dispatch(event);

        // Mark COMPLETED
        await Outbox.updateOne(
          { _id: event._id },
          {
            $set: {
              status: 'COMPLETED',
              lockedUntil: null,
              lastError: null,
            },
          },
        );
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isExhausted = event.attempts >= event.maxAttempts;

        if (isExhausted && event.type === 'INITIATE_PAYMENT') {
          // Compensate: move order to PAYMENT_FAILED
          try {
            await compensateInitiatePayment(event.payload as unknown as InitiatePaymentPayload);
          } catch (compensateErr) {
            logger.error(
              { compensateErr, eventId: event._id },
              'Outbox: compensation action also failed',
            );
          }
        }

        if (isExhausted) {
          await Outbox.updateOne(
            { _id: event._id },
            {
              $set: {
                status: 'FAILED',
                lockedUntil: null,
                lastError: errMsg,
              },
            },
          );
          logger.error(
            { eventId: event._id, type: event.type, attempts: event.attempts, err },
            'Outbox: event exhausted all retries and is now FAILED',
          );
        } else {
          // Exponential backoff for nextAttemptAt
          const backoffMs = Math.min(
            MAX_BACKOFF_MS,
            BASE_BACKOFF_MS * Math.pow(2, event.attempts - 1),
          );
          const nextAttemptAt = new Date(Date.now() + backoffMs);

          await Outbox.updateOne(
            { _id: event._id },
            {
              $set: {
                status: 'PENDING',
                lockedUntil: null,
                nextAttemptAt,
                lastError: errMsg,
              },
            },
          );

          logger.warn(
            {
              eventId: event._id,
              type: event.type,
              attempt: event.attempts,
              retryInMs: backoffMs,
              err,
            },
            'Outbox: event failed; scheduled for retry',
          );
        }
      }
    }),
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface OutboxProcessor {
  /** Stops the polling loop. Resolves once the current tick (if any) finishes. */
  stop(): Promise<void>;
}

export function startOutboxProcessor(): OutboxProcessor {
  let running = true;
  let currentTick: Promise<void> = Promise.resolve();
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const tick = (): void => {
    if (!running) return;

    currentTick = processBatch().catch((err) => {
      logger.error({ err }, 'Outbox processor: unexpected error in processBatch');
    });
  };

  // Run immediately, then on interval
  tick();
  intervalId = setInterval(tick, POLL_INTERVAL_MS);

  logger.info(
    { pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE },
    'Outbox processor started',
  );

  return {
    async stop(): Promise<void> {
      running = false;
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      await currentTick;
      logger.info('Outbox processor stopped');
    },
  };
}
