import type { FastifyRequest, FastifyReply } from 'fastify';
import { getOrderById } from './orders.service.js';

// ─── GET /orders/:id ───────────────────────────────────────────────────────────

export async function handleGetOrder(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as { id: string };

  const order = await getOrderById(id, request.user.id);

  reply.status(200).send({ order });
}
