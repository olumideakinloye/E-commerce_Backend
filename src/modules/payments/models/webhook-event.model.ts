import { Schema, model, type Document, type InferSchemaType } from 'mongoose';

export type WebhookStatus = 'RECEIVED' | 'PROCESSED' | 'FAILED' | 'IGNORED';

const webhookEventSchema = new Schema(
  {
    provider: {
      type: String,
      enum: ['paystack', 'stripe'] as const,
      required: true,
    },
    eventId: {
      type: String,
      required: true,
    },
    receivedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ['RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED'] as const,
      default: 'RECEIVED' as const,
      required: true,
      index: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },
  },
  {
    timestamps: false,
    versionKey: false,
  },
);

// Critical unique compound index for Scenario E duplicate webhook suppression
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

// TTL index to automatically purge old webhook audit events after 90 days (7,776,000 seconds)
webhookEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export type WebhookEventDoc = InferSchemaType<typeof webhookEventSchema> & Document;
export const WebhookEvent = model<WebhookEventDoc>('WebhookEvent', webhookEventSchema);
