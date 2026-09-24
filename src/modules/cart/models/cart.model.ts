import { Schema, model, type Document, type InferSchemaType } from 'mongoose';

export const MAX_CART_ITEMS = 100;

const cartItemSchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    qty: {
      type: Number,
      required: true,
      min: 1,
      max: 99,
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer',
      },
    },
  },
  { _id: false },
);

const cartSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    items: {
      type: [cartItemSchema],
      default: [],
      validate: {
        validator: (items: unknown[]) => items.length <= MAX_CART_ITEMS,
        message: `Cart cannot contain more than ${MAX_CART_ITEMS} distinct items`,
      },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

export type CartDoc = InferSchemaType<typeof cartSchema> & Document;
export const Cart = model<CartDoc>('Cart', cartSchema);
