import type { FastifyRequest, FastifyReply } from 'fastify';
import { BadRequestError } from '@common/errors.js';
import { checkout, getOrderById, listOrders, cancelOrder } from './orders.service.js';
import { checkoutSchema, orderListQuerySchema } from './orders.schemas.js';

// ─── POST /orders/checkout ─────────────────────────────────────────────────────

export async function handleCheckout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const idempotencyKey = request.headers['idempotency-key'];
  if (!idempotencyKey || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    throw new BadRequestError('Idempotency-Key header is required for checkout');
  }

  const input = checkoutSchema.parse(request.body);
  const result = await checkout(request.user.id, input, idempotencyKey.trim());

  reply.status(result.statusCode).send(result.body);
}

// ─── GET /orders ───────────────────────────────────────────────────────────────

export async function handleListOrders(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = orderListQuerySchema.parse(request.query);
  const result = await listOrders(request.user.id, query);

  reply.status(200).send(result);
}

// ─── GET /orders/:id ───────────────────────────────────────────────────────────

export async function handleGetOrder(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as { id: string };
  const order = await getOrderById(id, request.user.id);

  reply.status(200).send({ order });
}

// ─── POST /orders/:id/cancel ───────────────────────────────────────────────────

export async function handleCancelOrder(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as { id: string };
  const order = await cancelOrder(id, request.user.id);

  reply.status(200).send({
    order,
    message: 'Order cancelled successfully',
  });
}
