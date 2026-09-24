import { Schema, model, type Document, type InferSchemaType } from 'mongoose';

export type ReservationStatus = 'ACTIVE' | 'COMMITTED' | 'RELEASED' | 'EXPIRED';

const reservationItemSchema = new Schema(
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
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer',
      },
    },
  },
  { _id: false },
);

const reservationSchema = new Schema(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      unique: true,
      index: true,
    },
    items: {
      type: [reservationItemSchema],
      required: true,
      validate: {
        validator: (items: unknown[]) => items.length > 0,
        message: 'Reservation must contain at least one item',
      },
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED'] as const,
      default: 'ACTIVE' as const,
      required: true,
      index: true,
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

// Critical compound index for reservation sweeper / expiry worker
reservationSchema.index({ status: 1, expiresAt: 1 });

export type ReservationDoc = InferSchemaType<typeof reservationSchema> & Document;
export const Reservation = model<ReservationDoc>('Reservation', reservationSchema);
