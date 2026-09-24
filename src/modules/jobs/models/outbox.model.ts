import { Schema, model, type Document, type InferSchemaType } from 'mongoose';

export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

const outboxSchema = new Schema(
  {
    type: {
      type: String,
      required: true,
      index: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'] as const,
      default: 'PENDING' as const,
      required: true,
      index: true,
    },
    attempts: {
      type: Number,
      default: 0,
      required: true,
    },
    maxAttempts: {
      type: Number,
      default: 5,
      required: true,
    },
    nextAttemptAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    lockedUntil: {
      type: Date,
      default: null,
    },
    lastError: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Worker polling and lease-claiming indexes
outboxSchema.index({ status: 1, nextAttemptAt: 1 });
outboxSchema.index({ status: 1, lockedUntil: 1 });

export type OutboxDoc = InferSchemaType<typeof outboxSchema> & Document;
export const Outbox = model<OutboxDoc>('Outbox', outboxSchema);
