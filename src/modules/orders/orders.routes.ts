import type { FastifyInstance } from 'fastify';
import { authenticate } from '@common/middleware/authenticate.js';
import { handleGetOrder } from './orders.controller.js';

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  // GET /orders/:id — owner-only; checkout/list endpoints land in Phase 7
  app.get('/:id', { preHandler: [authenticate] }, handleGetOrder);
}
