import { Types } from 'mongoose';
import { Inventory, type InventoryDoc } from './models/inventory.model.js';

export async function getInventoryByProductId(
  productId: string | Types.ObjectId,
): Promise<InventoryDoc | null> {
  const pId = typeof productId === 'string' ? new Types.ObjectId(productId) : productId;
  return Inventory.findOne({ productId: pId });
}

export async function getInventoryForProducts(
  productIds: (string | Types.ObjectId)[],
): Promise<Map<string, { onHand: number; reserved: number; available: number }>> {
  const ids = productIds.map((id) => (typeof id === 'string' ? new Types.ObjectId(id) : id));
  const docs = await Inventory.find({ productId: { $in: ids } });

  const map = new Map<string, { onHand: number; reserved: number; available: number }>();
  for (const doc of docs) {
    map.set(doc.productId.toString(), {
      onHand: doc.onHand,
      reserved: doc.reserved,
      available: Math.max(0, doc.onHand - doc.reserved),
    });
  }

  return map;
}

export async function upsertInventory(
  productId: string | Types.ObjectId,
  onHand: number,
): Promise<InventoryDoc> {
  const pId = typeof productId === 'string' ? new Types.ObjectId(productId) : productId;
  const doc = await Inventory.findOneAndUpdate(
    { productId: pId },
    { $set: { onHand }, $setOnInsert: { reserved: 0 } },
    { returnDocument: 'after', upsert: true, runValidators: true },
  );
  return doc;
}
