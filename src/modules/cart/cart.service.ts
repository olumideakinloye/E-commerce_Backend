import { Types } from 'mongoose';
import { NotFoundError, BadRequestError } from '@common/errors.js';
import { Product } from '@modules/products/models/product.model.js';
import { getInventoryForProducts } from '@modules/inventory/inventory.repository.js';
import {
  findOrCreateCart,
  addOrUpdateCartItem,
  updateCartItemQuantity,
  removeCartItem,
  clearCart as repoClearCart,
} from './cart.repository.js';

export type CartItemWarning = 'UNAVAILABLE' | 'OUT_OF_STOCK' | 'QUANTITY_REDUCED';

export interface LiveCartItem {
  productId: string;
  name: string;
  slug: string;
  priceMinor: number;
  currency: string;
  qty: number;
  effectiveQty: number;
  availableStock: number;
  subtotalMinor: number;
  warnings: CartItemWarning[];
}

export interface LiveCart {
  items: LiveCartItem[];
  subtotalMinor: number;
  currency: string;
  itemCount: number;
  warnings: string[];
}

export async function getLiveCart(userId: string): Promise<LiveCart> {
  const cart = await findOrCreateCart(userId);

  if (cart.items.length === 0) {
    return {
      items: [],
      subtotalMinor: 0,
      currency: 'USD',
      itemCount: 0,
      warnings: [],
    };
  }

  const productIds = cart.items.map((i) => i.productId);
  const [products, inventoryMap] = await Promise.all([
    Product.find({ _id: { $in: productIds } }).lean(),
    getInventoryForProducts(productIds),
  ]);

  const productMap = new Map<string, (typeof products)[0]>();
  for (const p of products) {
    productMap.set(p._id.toString(), p);
  }

  let totalSubtotal = 0;
  let defaultCurrency = 'USD';
  const liveItems: LiveCartItem[] = [];
  const globalWarnings: string[] = [];

  for (const item of cart.items) {
    const pIdStr = item.productId.toString();
    const product = productMap.get(pIdStr);
    const inv = inventoryMap.get(pIdStr);
    const availableStock = inv ? inv.available : 0;
    const itemWarnings: CartItemWarning[] = [];

    // Product missing, archived, or marked unavailable
    if (!product || !product.isAvailable || product.archivedAt) {
      itemWarnings.push('UNAVAILABLE');
      globalWarnings.push(`Product '${product ? product.name : pIdStr}' is currently unavailable`);
      liveItems.push({
        productId: pIdStr,
        name: product ? product.name : 'Unavailable Product',
        slug: product ? product.slug : '',
        priceMinor: product ? product.priceMinor : 0,
        currency: product ? product.currency : 'USD',
        qty: item.qty,
        effectiveQty: 0,
        availableStock: 0,
        subtotalMinor: 0,
        warnings: itemWarnings,
      });
      continue;
    }

    defaultCurrency = product.currency;
    let effectiveQty = item.qty;

    if (availableStock <= 0) {
      itemWarnings.push('OUT_OF_STOCK');
      globalWarnings.push(`Product '${product.name}' is out of stock`);
      effectiveQty = 0;
    } else if (availableStock < item.qty) {
      itemWarnings.push('QUANTITY_REDUCED');
      globalWarnings.push(
        `Quantity for '${product.name}' reduced from ${item.qty} to ${availableStock} due to stock limits`,
      );
      effectiveQty = availableStock;
    }

    const itemSubtotal = effectiveQty * product.priceMinor;
    totalSubtotal += itemSubtotal;

    liveItems.push({
      productId: pIdStr,
      name: product.name,
      slug: product.slug,
      priceMinor: product.priceMinor,
      currency: product.currency,
      qty: item.qty,
      effectiveQty,
      availableStock,
      subtotalMinor: itemSubtotal,
      warnings: itemWarnings,
    });
  }

  return {
    items: liveItems,
    subtotalMinor: totalSubtotal,
    currency: defaultCurrency,
    itemCount: liveItems.reduce((acc, i) => acc + i.qty, 0),
    warnings: globalWarnings,
  };
}

export async function addCartItem(
  userId: string,
  productId: string,
  qty: number,
): Promise<LiveCart> {
  if (!Types.ObjectId.isValid(productId)) {
    throw new BadRequestError('Invalid product ID');
  }

  const product = await Product.findById(productId);
  if (!product || !product.isAvailable || product.archivedAt) {
    throw new NotFoundError('Product not found or unavailable');
  }

  await addOrUpdateCartItem(userId, productId, qty);
  return getLiveCart(userId);
}

export async function updateCartItem(
  userId: string,
  productId: string,
  qty: number,
): Promise<LiveCart> {
  if (!Types.ObjectId.isValid(productId)) {
    throw new BadRequestError('Invalid product ID');
  }

  const updated = await updateCartItemQuantity(userId, productId, qty);
  if (!updated) {
    throw new NotFoundError('Product not found in cart');
  }

  return getLiveCart(userId);
}

export async function removeCartItemAndGetLiveCart(
  userId: string,
  productId: string,
): Promise<LiveCart> {
  if (!Types.ObjectId.isValid(productId)) {
    throw new BadRequestError('Invalid product ID');
  }

  await removeCartItem(userId, productId);
  return getLiveCart(userId);
}

export async function clearUserCart(userId: string): Promise<void> {
  await repoClearCart(userId);
}
