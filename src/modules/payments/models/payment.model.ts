import { Schema, model, type Document, type InferSchemaType } from 'mongoose';

export type PaymentProviderType = 'paystack' | 'stripe';
export type PaymentStatus =
  'INITIATED' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'ABANDONED' | 'REFUNDED';

const paymentSchema = new Schema(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: ['paystack', 'stripe'] as const,
      required: true,
    },
    reference: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'ABANDONED', 'REFUNDED'] as const,
      default: 'INITIATED' as const,
      required: true,
      index: true,
    },
    amountMinor: {
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
    providerPayload: {
      type: Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

export type PaymentDoc = InferSchemaType<typeof paymentSchema> & Document;
export const Payment = model<PaymentDoc>('Payment', paymentSchema);
