/**
 * Audit Logging Service
 *
 * Persists immutable audit records for regulatory compliance and forensics.
 * Designed to fail-safe: failures to write an audit log entry are logged but
 * never crash or abort the parent transaction/operation.
 */

import { Types } from 'mongoose';
import { AuditLog } from '@common/models/audit-log.model.js';
import { logger } from '@common/logger.js';

export interface AuditLogEntry {
  actorId?: string | Types.ObjectId | null;
  actorEmail?: string | null;
  actorRole: 'ADMIN' | 'CUSTOMER' | 'SYSTEM';
  action: string;
  targetType: 'Product' | 'Inventory' | 'Order' | 'Payment' | 'User' | 'Reservation';
  targetId: string;
  diff?: {
    before?: unknown;
    after?: unknown;
  };
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function recordAuditLog(entry: AuditLogEntry): Promise<void> {
  try {
    const actorId =
      entry.actorId && typeof entry.actorId === 'string'
        ? new Types.ObjectId(entry.actorId)
        : (entry.actorId ?? null);

    await AuditLog.create({
      actorId,
      actorEmail: entry.actorEmail ?? null,
      actorRole: entry.actorRole,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      diff: entry.diff ?? { before: null, after: null },
      metadata: entry.metadata ?? {},
      ip: entry.ip ?? null,
    });

    logger.debug(
      {
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        actorRole: entry.actorRole,
      },
      'Audit log recorded',
    );
  } catch (err) {
    logger.error(
      { err, entry },
      'Failed to record audit log entry; continuing to prevent cascading failure',
    );
  }
}
