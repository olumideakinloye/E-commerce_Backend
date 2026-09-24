import type { OrderDoc } from './models/order.model.js';
import { findOrderByIdForUser } from './orders.repository.js';

export async function getOrderById(orderId: string, userId: string): Promise<OrderDoc> {
  return findOrderByIdForUser(orderId, userId);
}
