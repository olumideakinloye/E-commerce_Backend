import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { BadRequestError } from '@common/errors.js';
import {
  listProducts,
  getProductById,
  createProduct,
  updateProduct,
  updateProductAvailability,
  deleteProduct,
  updateInventoryOnHand,
} from './products.service.js';
import {
  ListProductsQuerySchema,
  CreateProductBodySchema,
  UpdateProductBodySchema,
  UpdateAvailabilityBodySchema,
  UpdateInventoryBodySchema,
} from './products.schemas.js';

// ─── Public Endpoints ─────────────────────────────────────────────────────────

export async function handleListProducts(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const result = ListProductsQuerySchema.safeParse(request.query);
  if (!result.success) {
    throw new BadRequestError('Validation failed', result.error.issues);
  }

  const catalog = await listProducts(result.data);

  return reply
    .header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
    .status(200)
    .send(catalog);
}

export async function handleGetProduct(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as { id: string };
  const product = await getProductById(id);

  // Generate strong ETag from product version, id, and updatedAt
  const etag = `"${createHash('sha1')
    .update(`${product.id}-${product.version}-${product.updatedAt || ''}`)
    .digest('hex')}"`;

  if (request.headers['if-none-match'] === etag) {
    return reply.status(304).send();
  }

  return reply
    .header('ETag', etag)
    .header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120')
    .status(200)
    .send(product);
}

// ─── Admin Endpoints ──────────────────────────────────────────────────────────

function getAuditActor(request: FastifyRequest) {
  return {
    actorId: request.user?.id,
    actorRole: (request.user?.role?.toUpperCase() as 'ADMIN' | 'CUSTOMER' | 'SYSTEM') || 'ADMIN',
    ip: request.ip,
  };
}

export async function handleCreateProduct(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const result = CreateProductBodySchema.safeParse(request.body);
  if (!result.success) {
    throw new BadRequestError('Validation failed', result.error.issues);
  }

  const product = await createProduct(result.data, getAuditActor(request));

  return reply.status(201).send(product);
}

export async function handleUpdateProduct(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as { id: string };
  const result = UpdateProductBodySchema.safeParse(request.body);
  if (!result.success) {
    throw new BadRequestError('Validation failed', result.error.issues);
  }

  const updated = await updateProduct(id, result.data, getAuditActor(request));

  return reply.status(200).send(updated);
}

export async function handleUpdateAvailability(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as { id: string };
  const result = UpdateAvailabilityBodySchema.safeParse(request.body);
  if (!result.success) {
    throw new BadRequestError('Validation failed', result.error.issues);
  }

  const updated = await updateProductAvailability(
    id,
    result.data.isAvailable,
    getAuditActor(request),
  );

  return reply.status(200).send(updated);
}

export async function handleDeleteProduct(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as { id: string };
  const response = await deleteProduct(id, getAuditActor(request));

  return reply.status(200).send(response);
}

export async function handleUpdateInventory(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { productId } = request.params as { productId: string };
  const result = UpdateInventoryBodySchema.safeParse(request.body);
  if (!result.success) {
    throw new BadRequestError('Validation failed', result.error.issues);
  }

  const inv = await updateInventoryOnHand(productId, result.data.onHand, getAuditActor(request));

  return reply.status(200).send(inv);
}
