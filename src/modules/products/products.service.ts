import { Types } from 'mongoose';
import { NotFoundError, ConflictError } from '@common/errors.js';
import { getCached, setCached, deleteCached } from '@common/utils/cache.js';
import { recordAuditLog } from '@common/utils/audit.js';
import {
  findProductsPaginated,
  findProductById,
  findProductBySlug,
  createProduct as repoCreateProduct,
  updateProduct as repoUpdateProduct,
  softDeleteProduct,
} from './products.repository.js';
import {
  getInventoryByProductId,
  getInventoryForProducts,
  upsertInventory,
} from '@modules/inventory/inventory.repository.js';
import type {
  ListProductsQuery,
  CreateProductBody,
  UpdateProductBody,
} from './products.schemas.js';
import type { ProductDoc } from './models/product.model.js';

const PRODUCT_CACHE_TTL = 60; // 60 seconds

export interface AuditActor {
  actorId?: string;
  actorEmail?: string;
  actorRole?: 'ADMIN' | 'CUSTOMER' | 'SYSTEM';
  ip?: string;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function computeStockStatus(available: number): {
  available: boolean;
  stockStatus: 'in_stock' | 'low_stock' | 'out_of_stock';
} {
  if (available > 5) {
    return { available: true, stockStatus: 'in_stock' };
  }
  if (available > 0) {
    return { available: true, stockStatus: 'low_stock' };
  }
  return { available: false, stockStatus: 'out_of_stock' };
}

export async function listProducts(query: ListProductsQuery) {
  const result = await findProductsPaginated(query);

  const productIds = result.items.map((p) => p._id.toString());
  const inventoryMap = await getInventoryForProducts(productIds);

  const items = result.items.map((product) => {
    const inv = inventoryMap.get(product._id.toString());
    const available = inv ? inv.available : 0;
    const { available: isAvailable, stockStatus } = computeStockStatus(available);

    return {
      id: product._id.toString(),
      name: product.name,
      slug: product.slug,
      description: product.description,
      priceMinor: product.priceMinor,
      currency: product.currency,
      category: product.category,
      tags: product.tags,
      isAvailable: product.isAvailable,
      stockStatus,
      inStock: isAvailable,
      version: product.version,
      createdAt: product.createdAt,
    };
  });

  return {
    items,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor,
  };
}

export async function getProductById(id: string) {
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError('Product not found');
  }

  const cacheKey = `product:${id}`;
  const cached = await getCached<Record<string, unknown>>(cacheKey);
  if (cached) {
    return cached;
  }

  const product = await findProductById(id);
  if (!product || !product.isAvailable) {
    throw new NotFoundError('Product not found');
  }

  const inv = await getInventoryByProductId(product._id);
  const available = inv ? inv.available : 0;
  const { available: isAvailable, stockStatus } = computeStockStatus(available);

  const formatted = {
    id: product._id.toString(),
    name: product.name,
    slug: product.slug,
    description: product.description,
    priceMinor: product.priceMinor,
    currency: product.currency,
    category: product.category,
    tags: product.tags,
    isAvailable: product.isAvailable,
    stockStatus,
    inStock: isAvailable,
    version: product.version,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };

  await setCached(cacheKey, formatted, PRODUCT_CACHE_TTL);

  return formatted;
}

export async function createProduct(data: CreateProductBody, actor?: AuditActor) {
  let slug = data.slug || slugify(data.name);

  // Check slug uniqueness
  const existing = await findProductBySlug(slug);
  if (existing) {
    if (data.slug) {
      throw new ConflictError(`Product with slug '${slug}' already exists`);
    }
    // Auto-resolve slug collision when generated
    slug = `${slug}-${Math.random().toString(36).substring(2, 7)}`;
  }

  const productData: Partial<ProductDoc> = {
    name: data.name,
    slug,
    description: data.description,
    priceMinor: data.priceMinor,
    currency: data.currency,
    category: data.category,
    tags: data.tags,
    isAvailable: true,
    version: 1,
  };

  const product = await repoCreateProduct(productData);

  // Initialize inventory
  const initialStock = data.initialStock ?? 0;
  await upsertInventory(product._id, initialStock);

  await deleteCached('product:*');

  void recordAuditLog({
    actorId: actor?.actorId,
    actorEmail: actor?.actorEmail,
    actorRole: actor?.actorRole ?? 'ADMIN',
    action: 'PRODUCT_CREATED',
    targetType: 'Product',
    targetId: product._id.toString(),
    diff: { after: productData },
    ip: actor?.ip,
  });

  return {
    id: product._id.toString(),
    name: product.name,
    slug: product.slug,
    description: product.description,
    priceMinor: product.priceMinor,
    currency: product.currency,
    category: product.category,
    tags: product.tags,
    isAvailable: product.isAvailable,
    version: product.version,
    onHand: initialStock,
    createdAt: product.createdAt,
  };
}

export async function updateProduct(id: string, data: UpdateProductBody, actor?: AuditActor) {
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError('Product not found');
  }

  const existing = await findProductById(id);
  if (!existing) {
    throw new NotFoundError('Product not found');
  }

  // Price change detection: if price changes, bump version for Scenario B
  const priceChanged = data.priceMinor !== undefined && data.priceMinor !== existing.priceMinor;

  const updated = await repoUpdateProduct(id, data as Record<string, unknown>, priceChanged);
  if (!updated) {
    throw new NotFoundError('Product not found');
  }

  await deleteCached(`product:${id}`);
  await deleteCached('product:*');

  void recordAuditLog({
    actorId: actor?.actorId,
    actorEmail: actor?.actorEmail,
    actorRole: actor?.actorRole ?? 'ADMIN',
    action: 'PRODUCT_UPDATED',
    targetType: 'Product',
    targetId: id,
    diff: {
      before: {
        name: existing.name,
        priceMinor: existing.priceMinor,
        description: existing.description,
      },
      after: data,
    },
    ip: actor?.ip,
  });

  return {
    id: updated._id.toString(),
    name: updated.name,
    slug: updated.slug,
    description: updated.description,
    priceMinor: updated.priceMinor,
    currency: updated.currency,
    category: updated.category,
    tags: updated.tags,
    isAvailable: updated.isAvailable,
    version: updated.version,
    updatedAt: updated.updatedAt,
  };
}

export async function updateProductAvailability(
  id: string,
  isAvailable: boolean,
  actor?: AuditActor,
) {
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError('Product not found');
  }

  const updated = await repoUpdateProduct(id, { isAvailable }, false);
  if (!updated) {
    throw new NotFoundError('Product not found');
  }

  await deleteCached(`product:${id}`);
  await deleteCached('product:*');

  void recordAuditLog({
    actorId: actor?.actorId,
    actorEmail: actor?.actorEmail,
    actorRole: actor?.actorRole ?? 'ADMIN',
    action: 'PRODUCT_AVAILABILITY_CHANGED',
    targetType: 'Product',
    targetId: id,
    diff: { after: { isAvailable } },
    ip: actor?.ip,
  });

  return {
    id: updated._id.toString(),
    isAvailable: updated.isAvailable,
  };
}

export async function deleteProduct(id: string, actor?: AuditActor) {
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError('Product not found');
  }

  const archived = await softDeleteProduct(id);
  if (!archived) {
    throw new NotFoundError('Product not found');
  }

  await deleteCached(`product:${id}`);
  await deleteCached('product:*');

  void recordAuditLog({
    actorId: actor?.actorId,
    actorEmail: actor?.actorEmail,
    actorRole: actor?.actorRole ?? 'ADMIN',
    action: 'PRODUCT_ARCHIVED',
    targetType: 'Product',
    targetId: id,
    ip: actor?.ip,
  });

  return { message: 'Product archived successfully' };
}

export async function updateInventoryOnHand(productId: string, onHand: number, actor?: AuditActor) {
  if (!Types.ObjectId.isValid(productId)) {
    throw new NotFoundError('Product not found');
  }

  const product = await findProductById(productId);
  if (!product) {
    throw new NotFoundError('Product not found');
  }

  const inv = await upsertInventory(productId, onHand);
  await deleteCached(`product:${productId}`);

  void recordAuditLog({
    actorId: actor?.actorId,
    actorEmail: actor?.actorEmail,
    actorRole: actor?.actorRole ?? 'ADMIN',
    action: 'INVENTORY_ADJUSTED',
    targetType: 'Inventory',
    targetId: productId,
    diff: { after: { onHand } },
    ip: actor?.ip,
  });

  return {
    productId: inv.productId.toString(),
    onHand: inv.onHand,
    reserved: inv.reserved,
    available: inv.available,
  };
}
