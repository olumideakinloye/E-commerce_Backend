import type { FastifyInstance } from 'fastify';
import { authenticate } from '@common/middleware/authenticate.js';
import {
  handleCheckout,
  handleListOrders,
  handleGetOrder,
  handleCancelOrder,
} from './orders.controller.js';
import { env } from '@config/env.js';

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  // All order routes require authenticated user
  app.addHook('preHandler', authenticate);

  // POST /orders/checkout — idempotent checkout with rate limiting (disabled in test)
  app.post(
    '/checkout',
    {
      config: {
        rateLimit:
          env.NODE_ENV === 'test'
            ? false
            : {
                max: env.RATE_LIMIT_CHECKOUT_MAX,
                timeWindow: env.RATE_LIMIT_CHECKOUT_WINDOW_MS,
              },
      },
    },
    handleCheckout,
  );

  // GET /orders — keyset-paginated user orders
  app.get('/', handleListOrders);

  // GET /orders/:id — anti-IDOR owner-scoped single order
  app.get('/:id', handleGetOrder);

  // POST /orders/:id/cancel — cancel pending order and release reserved stock
  app.post('/:id/cancel', handleCancelOrder);
}
