import { Types } from 'mongoose';
import { Product, type ProductDoc } from './models/product.model.js';
import type { ListProductsQuery } from './products.schemas.js';

export interface CursorPayload {
  t: 'createdAt' | 'priceMinor';
  v: string | number;
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursorStr: string): CursorPayload | null {
  try {
    const raw = Buffer.from(cursorStr, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.t || parsed.v === undefined || !parsed.id) return null;
    return parsed as CursorPayload;
  } catch {
    return null;
  }
}

export async function findProductsPaginated(
  query: ListProductsQuery & { includeUnavailable?: boolean },
) {
  const filter: Record<string, unknown> = {};

  if (!query.includeUnavailable) {
    filter.isAvailable = true;
  }

  if (query.category) {
    filter.category = query.category;
  }

  if (query.search) {
    filter.$text = { $search: query.search };
  }

  const sort: Record<string, 1 | -1> = {};
  let sortField: 'createdAt' | 'priceMinor';
  let sortOrder: 1 | -1;

  if (query.sort === 'price_asc') {
    sortField = 'priceMinor';
    sortOrder = 1;
    sort.priceMinor = 1;
    sort._id = 1;
  } else if (query.sort === 'price_desc') {
    sortField = 'priceMinor';
    sortOrder = -1;
    sort.priceMinor = -1;
    sort._id = -1;
  } else {
    sortField = 'createdAt';
    sortOrder = -1;
    sort.createdAt = -1;
    sort._id = -1;
  }

  // Handle keyset cursor
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    if (cursor && cursor.t === sortField) {
      const cursorId = new Types.ObjectId(cursor.id);
      const cursorVal =
        sortField === 'createdAt' ? new Date(cursor.v as string) : (cursor.v as number);

      if (sortOrder === -1) {
        // Descending
        filter.$or = [
          { [sortField]: { $lt: cursorVal } },
          { [sortField]: cursorVal, _id: { $lt: cursorId } },
        ];
      } else {
        // Ascending
        filter.$or = [
          { [sortField]: { $gt: cursorVal } },
          { [sortField]: cursorVal, _id: { $gt: cursorId } },
        ];
      }
    }
  }

  const limit = query.limit;
  const items = await Product.find(filter as Record<string, unknown>)
    .sort(sort)
    .limit(limit + 1)
    .lean();

  const hasMore = items.length > limit;
  const pageItems = hasMore ? items.slice(0, limit) : items;

  let nextCursor: string | null = null;
  if (hasMore && pageItems.length > 0) {
    const lastItem = pageItems[pageItems.length - 1];
    if (lastItem) {
      const val =
        sortField === 'createdAt'
          ? (lastItem.createdAt as Date).toISOString()
          : lastItem.priceMinor;
      nextCursor = encodeCursor({
        t: sortField,
        v: val,
        id: (lastItem._id as Types.ObjectId).toString(),
      });
    }
  }

  return {
    items: pageItems,
    hasMore,
    nextCursor,
  };
}

export async function findProductById(id: string | Types.ObjectId): Promise<ProductDoc | null> {
  const pId = typeof id === 'string' ? new Types.ObjectId(id) : id;
  return Product.findById(pId);
}

export async function findProductBySlug(slug: string): Promise<ProductDoc | null> {
  return Product.findOne({ slug: slug.toLowerCase().trim() });
}

export async function createProduct(data: Partial<ProductDoc>): Promise<ProductDoc> {
  return Product.create(data);
}

export async function updateProduct(
  id: string | Types.ObjectId,
  updates: Record<string, unknown>,
  bumpVersion = false,
): Promise<ProductDoc | null> {
  const pId = typeof id === 'string' ? new Types.ObjectId(id) : id;
  const updateQuery: Record<string, unknown> = { $set: updates };
  if (bumpVersion) {
    updateQuery.$inc = { version: 1 };
  }

  return Product.findByIdAndUpdate(pId, updateQuery, {
    returnDocument: 'after',
    runValidators: true,
  });
}

export async function softDeleteProduct(id: string | Types.ObjectId): Promise<ProductDoc | null> {
  const pId = typeof id === 'string' ? new Types.ObjectId(id) : id;
  return Product.findByIdAndUpdate(
    pId,
    {
      $set: {
        isAvailable: false,
        archivedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
}
