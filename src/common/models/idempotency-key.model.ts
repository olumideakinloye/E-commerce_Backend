import { Schema, model, type Document, type InferSchemaType } from 'mongoose';

const idempotencyKeySchema = new Schema(
  {
    key: {
      type: String,
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    requestHash: {
      type: String,
      required: true,
    },
    response: {
      statusCode: {
        type: Number,
        required: true,
      },
      headers: {
        type: Schema.Types.Mixed,
        default: {},
      },
      body: {
        type: Schema.Types.Mixed,
        required: true,
      },
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);

// Unique compound index scoped by user and idempotency key
idempotencyKeySchema.index({ userId: 1, key: 1 }, { unique: true });

// TTL index to automatically purge expired idempotency keys
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type IdempotencyKeyDoc = InferSchemaType<typeof idempotencyKeySchema> & Document;
export const IdempotencyKey = model<IdempotencyKeyDoc>('IdempotencyKey', idempotencyKeySchema);
