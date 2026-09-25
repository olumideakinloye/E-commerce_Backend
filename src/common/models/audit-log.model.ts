import { Schema, model, type Document, type InferSchemaType } from 'mongoose';

const auditLogSchema = new Schema(
  {
    actorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    actorEmail: {
      type: String,
      default: null,
    },
    actorRole: {
      type: String,
      enum: ['ADMIN', 'CUSTOMER', 'SYSTEM'],
      required: true,
      index: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    targetType: {
      type: String,
      required: true,
      index: true,
    },
    targetId: {
      type: String,
      required: true,
      index: true,
    },
    diff: {
      before: { type: Schema.Types.Mixed, default: null },
      after: { type: Schema.Types.Mixed, default: null },
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    ip: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);

// Compound indexes for audit queries
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema> & Document;
export const AuditLog = model<AuditLogDoc>('AuditLog', auditLogSchema);
