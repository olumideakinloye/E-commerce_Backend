import type { FastifyInstance } from 'fastify';
import { authenticate, authorize } from '@common/middleware/authenticate.js';
import { idempotency } from '@common/middleware/idempotency.js';
import {
  handleListProducts,
  handleGetProduct,
  handleCreateProduct,
  handleUpdateProduct,
  handleUpdateAvailability,
  handleDeleteProduct,
  handleUpdateInventory,
} from './products.controller.js';

export async function productRoutes(app: FastifyInstance): Promise<void> {
  // Public catalog routes
  app.get('/products', handleListProducts);
  app.get('/products/:id', handleGetProduct);

  // Admin routes protected by authentication, admin role, and optional idempotency
  app.post(
    '/admin/products',
    {
      preHandler: [authenticate, authorize('admin'), idempotency({ required: false })],
    },
    handleCreateProduct,
  );

  app.patch(
    '/admin/products/:id',
    {
      preHandler: [authenticate, authorize('admin')],
    },
    handleUpdateProduct,
  );

  app.patch(
    '/admin/products/:id/availability',
    {
      preHandler: [authenticate, authorize('admin')],
    },
    handleUpdateAvailability,
  );

  app.delete(
    '/admin/products/:id',
    {
      preHandler: [authenticate, authorize('admin')],
    },
    handleDeleteProduct,
  );

  app.put(
    '/admin/inventory/:productId',
    {
      preHandler: [authenticate, authorize('admin')],
    },
    handleUpdateInventory,
  );
}
