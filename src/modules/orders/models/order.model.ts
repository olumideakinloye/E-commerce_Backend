import { Schema, model, type Document, type InferSchemaType } from 'mongoose';

export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'PAYMENT_FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'FULFILLED'
  | 'REFUNDED';

const orderLineSchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    unitPriceMinor: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer minor unit',
      },
    },
    currency: {
      type: String,
      required: true,
      uppercase: true,
    },
    qty: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer',
      },
    },
    totalMinor: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer minor unit',
      },
    },
  },
  { _id: false },
);

const orderTotalsSchema = new Schema(
  {
    subtotalMinor: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer minor unit',
      },
    },
    taxMinor: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer minor unit',
      },
    },
    shippingMinor: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer minor unit',
      },
    },
    grandTotalMinor: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer minor unit',
      },
    },
    currency: {
      type: String,
      required: true,
      uppercase: true,
    },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: [
        'PENDING_PAYMENT',
        'PAID',
        'PAYMENT_FAILED',
        'EXPIRED',
        'CANCELLED',
        'FULFILLED',
        'REFUNDED',
      ] as const,
      default: 'PENDING_PAYMENT' as const,
      required: true,
      index: true,
    },
    lines: {
      type: [orderLineSchema],
      required: true,
      validate: {
        validator: (lines: unknown[]) => lines.length > 0,
        message: 'Order must contain at least one line item',
      },
    },
    totals: {
      type: orderTotalsSchema,
      required: true,
    },
    paymentRef: {
      type: String,
      default: null,
    },
    idempotencyKey: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Critical indexes
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
orderSchema.index({ paymentRef: 1 }, { unique: true, sparse: true });
orderSchema.index({ status: 1, createdAt: 1 });

export type OrderDoc = InferSchemaType<typeof orderSchema> & Document;
export const Order = model<OrderDoc>('Order', orderSchema);
