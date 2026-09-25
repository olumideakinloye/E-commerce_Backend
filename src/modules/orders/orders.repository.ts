import { Types } from 'mongoose';
import { findOwnedOrThrow } from '@common/ownership.js';
import { Order, type OrderDoc, type OrderStatus } from './models/order.model.js';
import type { OrderListQuery } from './orders.schemas.js';

export interface OrderCursorPayload {
  createdAt: string;
  id: string;
}

export function encodeOrderCursor(payload: OrderCursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeOrderCursor(cursor: string): OrderCursorPayload | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(raw) as OrderCursorPayload;
    if (parsed.createdAt && parsed.id) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch a single order, scoped to its owner in the query itself (anti-IDOR).
 * Throws NotFoundError (404) if the order doesn't exist OR belongs to someone
 * else — the two cases are indistinguishable to the caller by design.
 */
export async function findOrderByIdForUser(orderId: string, userId: string): Promise<OrderDoc> {
  return findOwnedOrThrow(Order, orderId, userId, 'Order not found');
}

/**
 * Keyset-paginated list of orders for a user.
 * Sorted by createdAt desc, _id desc.
 * Avoids skip/limit pagination on large collections.
 */
export async function listOrdersForUser(
  userId: string,
  query: OrderListQuery,
): Promise<{ orders: OrderDoc[]; nextCursor: string | null; hasMore: boolean }> {
  const filter: Record<string, unknown> = {
    userId: new Types.ObjectId(userId),
  };

  if (query.status) {
    filter.status = query.status;
  }

  if (query.cursor) {
    const decoded = decodeOrderCursor(query.cursor);
    if (decoded) {
      const cursorDate = new Date(decoded.createdAt);
      const cursorId = new Types.ObjectId(decoded.id);

      filter.$or = [
        { createdAt: { $lt: cursorDate } },
        { createdAt: cursorDate, _id: { $lt: cursorId } },
      ];
    }
  }

  const limit = query.limit;
  const items = await Order.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .exec();

  const hasMore = items.length > limit;
  const orders = hasMore ? items.slice(0, limit) : items;

  let nextCursor: string | null = null;
  if (hasMore && orders.length > 0) {
    const last = orders[orders.length - 1];
    if (last) {
      nextCursor = encodeOrderCursor({
        createdAt: (last.createdAt as Date).toISOString(),
        id: last._id.toString(),
      });
    }
  }

  return { orders, nextCursor, hasMore };
}

/**
 * Atomically transition order status (CAS).
 * Guarantees state machine correctness even under concurrent webhook or cancellation calls.
 */
export async function transitionOrderStatus(
  orderId: string | Types.ObjectId,
  fromStatus: OrderStatus | OrderStatus[],
  toStatus: OrderStatus,
  extraUpdates: Record<string, unknown> = {},
): Promise<OrderDoc | null> {
  const oId = typeof orderId === 'string' ? new Types.ObjectId(orderId) : orderId;
  const statusFilter = Array.isArray(fromStatus) ? { $in: fromStatus } : fromStatus;

  return Order.findOneAndUpdate(
    {
      _id: oId,
      status: statusFilter,
    },
    {
      $set: {
        status: toStatus,
        ...extraUpdates,
      },
    },
    { returnDocument: 'after' },
  );
}
