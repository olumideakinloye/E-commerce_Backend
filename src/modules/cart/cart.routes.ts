import type { FastifyInstance } from 'fastify';
import { authenticate } from '@common/middleware/authenticate.js';
import {
  handleGetCart,
  handleAddCartItem,
  handleUpdateCartItem,
  handleRemoveCartItem,
  handleClearCart,
} from './cart.controller.js';

export async function cartRoutes(app: FastifyInstance): Promise<void> {
  // All cart endpoints are customer-authenticated and scoped to request.user.id
  app.addHook('preHandler', authenticate);

  app.get('/', handleGetCart);
  app.post('/items', handleAddCartItem);
  app.patch('/items/:productId', handleUpdateCartItem);
  app.delete('/items/:productId', handleRemoveCartItem);
  app.delete('/', handleClearCart);
}
