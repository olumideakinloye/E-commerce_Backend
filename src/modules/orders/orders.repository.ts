import { findOwnedOrThrow } from '@common/ownership.js';
import { Order, type OrderDoc } from './models/order.model.js';

/**
 * Fetch a single order, scoped to its owner in the query itself (anti-IDOR).
 * Throws NotFoundError (404) if the order doesn't exist OR belongs to someone
 * else — the two cases are indistinguishable to the caller by design.
 */
export async function findOrderByIdForUser(orderId: string, userId: string): Promise<OrderDoc> {
  return findOwnedOrThrow(Order, orderId, userId, 'Order not found');
}
