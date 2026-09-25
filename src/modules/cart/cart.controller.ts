import type { FastifyRequest, FastifyReply } from 'fastify';
import { BadRequestError } from '@common/errors.js';
import {
  getLiveCart,
  addCartItem,
  updateCartItem,
  removeCartItemAndGetLiveCart,
  clearUserCart,
} from './cart.service.js';
import { AddCartItemBodySchema, UpdateCartItemBodySchema } from './cart.schemas.js';

export async function handleGetCart(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const cart = await getLiveCart(request.user.id);
  return reply.status(200).send(cart);
}

export async function handleAddCartItem(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const result = AddCartItemBodySchema.safeParse(request.body);
  if (!result.success) {
    throw new BadRequestError('Validation failed', result.error.issues);
  }

  const cart = await addCartItem(request.user.id, result.data.productId, result.data.qty);
  return reply.status(200).send(cart);
}

export async function handleUpdateCartItem(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { productId } = request.params as { productId: string };
  const result = UpdateCartItemBodySchema.safeParse(request.body);
  if (!result.success) {
    throw new BadRequestError('Validation failed', result.error.issues);
  }

  const cart = await updateCartItem(request.user.id, productId, result.data.qty);
  return reply.status(200).send(cart);
}

export async function handleRemoveCartItem(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { productId } = request.params as { productId: string };
  const cart = await removeCartItemAndGetLiveCart(request.user.id, productId);
  return reply.status(200).send(cart);
}

export async function handleClearCart(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await clearUserCart(request.user.id);
  return reply.status(204).send();
}
