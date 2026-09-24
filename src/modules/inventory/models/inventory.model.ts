import { Schema, model, type Document, type InferSchemaType } from 'mongoose';

const inventorySchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      unique: true,
      index: true,
    },
    onHand: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer',
      },
    },
    reserved: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer',
      },
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Virtual for available stock (onHand - reserved)
inventorySchema.virtual('available').get(function () {
  return Math.max(0, this.onHand - this.reserved);
});

export type InventoryDoc = InferSchemaType<typeof inventorySchema> &
  Document & {
    available: number;
  };

export const Inventory = model<InventoryDoc>('Inventory', inventorySchema);
