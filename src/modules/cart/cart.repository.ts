import { Types } from 'mongoose';
import { Cart, type CartDoc, MAX_CART_ITEMS } from './models/cart.model.js';
import { BadRequestError } from '@common/errors.js';

export async function findCartByUserId(userId: string | Types.ObjectId): Promise<CartDoc | null> {
  const uId = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
  return Cart.findOne({ userId: uId });
}

export async function findOrCreateCart(userId: string | Types.ObjectId): Promise<CartDoc> {
  const uId = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
  let cart = await Cart.findOne({ userId: uId });
  if (!cart) {
    cart = await Cart.create({ userId: uId, items: [] });
  }
  return cart;
}

export async function addOrUpdateCartItem(
  userId: string | Types.ObjectId,
  productId: string | Types.ObjectId,
  qty: number,
): Promise<CartDoc> {
  const uId = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
  const pId = typeof productId === 'string' ? new Types.ObjectId(productId) : productId;

  // Check if item already in cart
  const existing = await Cart.findOne({ userId: uId, 'items.productId': pId });

  if (existing) {
    const existingItem = existing.items.find((i) => i.productId.toString() === pId.toString());
    const currentQty = existingItem ? existingItem.qty : 0;
    const newQty = Math.min(99, currentQty + qty);

    const updated = await Cart.findOneAndUpdate(
      { userId: uId, 'items.productId': pId },
      { $set: { 'items.$.qty': newQty } },
      { returnDocument: 'after', runValidators: true },
    );
    return updated!;
  }

  // Not in cart yet -> check maximum item cap before pushing
  const cart = await findOrCreateCart(uId);
  if (cart.items.length >= MAX_CART_ITEMS) {
    throw new BadRequestError(`Cart cannot exceed ${MAX_CART_ITEMS} distinct items`);
  }

  const updated = await Cart.findOneAndUpdate(
    { userId: uId },
    { $push: { items: { productId: pId, qty: Math.min(99, qty) } } },
    { returnDocument: 'after', upsert: true, runValidators: true },
  );

  return updated!;
}

export async function updateCartItemQuantity(
  userId: string | Types.ObjectId,
  productId: string | Types.ObjectId,
  qty: number,
): Promise<CartDoc | null> {
  const uId = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
  const pId = typeof productId === 'string' ? new Types.ObjectId(productId) : productId;

  return Cart.findOneAndUpdate(
    { userId: uId, 'items.productId': pId },
    { $set: { 'items.$.qty': qty } },
    { returnDocument: 'after', runValidators: true },
  );
}

export async function removeCartItem(
  userId: string | Types.ObjectId,
  productId: string | Types.ObjectId,
): Promise<CartDoc | null> {
  const uId = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
  const pId = typeof productId === 'string' ? new Types.ObjectId(productId) : productId;

  return Cart.findOneAndUpdate(
    { userId: uId },
    { $pull: { items: { productId: pId } } },
    { returnDocument: 'after' },
  );
}

export async function clearCart(userId: string | Types.ObjectId): Promise<CartDoc | null> {
  const uId = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
  return Cart.findOneAndUpdate(
    { userId: uId },
    { $set: { items: [] } },
    { returnDocument: 'after' },
  );
}
