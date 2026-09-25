/**
 * Invariant Checker Job (Phase 13: Observability & Invariant Protection)
 *
 * Runs periodically to assert core business invariants across the database:
 *   1. Stock Invariant: 0 <= reserved <= onHand and onHand >= 0 for all SKUs.
 *   2. Order-Reservation Invariant: Every PAID order must have a COMMITTED reservation.
 *   3. Stale Order Invariant: No PENDING_PAYMENT orders older than TTL + grace margin.
 *
 * If any invariant is violated, emits a CRITICAL structured alert for PagerDuty/Sentry.
 */

import { Inventory } from '@modules/inventory/models/inventory.model.js';
import { Order } from '@modules/orders/models/order.model.js';
import { Reservation } from '@modules/inventory/models/reservation.model.js';
import { logger } from '@common/logger.js';

export interface InvariantCheckResult {
  passed: boolean;
  violations: Array<{
    rule: string;
    targetId: string;
    details: Record<string, unknown>;
  }>;
}

export async function runInvariantChecks(): Promise<InvariantCheckResult> {
  const violations: InvariantCheckResult['violations'] = [];

  // ─── Rule 1: Stock Invariant: 0 <= reserved <= onHand ───────────────────────
  const corruptedInventory = await Inventory.find({
    $or: [
      { onHand: { $lt: 0 } },
      { reserved: { $lt: 0 } },
      { $expr: { $gt: ['$reserved', '$onHand'] } },
    ],
  }).lean();

  for (const inv of corruptedInventory) {
    violations.push({
      rule: 'INVENTORY_STOCK_BOUNDS',
      targetId: inv.productId.toString(),
      details: {
        onHand: inv.onHand,
        reserved: inv.reserved,
      },
    });

    logger.fatal(
      {
        productId: inv.productId,
        onHand: inv.onHand,
        reserved: inv.reserved,
      },
      'CRITICAL INVARIANT VIOLATION: Inventory stock out of bounds (reserved > onHand or negative stock)',
    );
  }

  // ─── Rule 2: Order-Reservation Invariant: PAID orders must be COMMITTED ─────
  const recentPaidOrders = await Order.find({
    status: 'PAID',
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // Last 24 hours
  })
    .select('_id status')
    .lean();

  if (recentPaidOrders.length > 0) {
    const orderIds = recentPaidOrders.map((o) => o._id);
    const uncommittedReservations = await Reservation.find({
      orderId: { $in: orderIds },
      status: { $ne: 'COMMITTED' },
    }).lean();

    for (const res of uncommittedReservations) {
      violations.push({
        rule: 'PAID_ORDER_UNCOMMITTED_RESERVATION',
        targetId: res.orderId.toString(),
        details: {
          reservationStatus: res.status,
          reservationId: res._id.toString(),
        },
      });

      logger.fatal(
        {
          orderId: res.orderId,
          reservationStatus: res.status,
        },
        'CRITICAL INVARIANT VIOLATION: Order is PAID but reservation was not COMMITTED',
      );
    }
  }

  // ─── Rule 3: Stale Pending Orders ───────────────────────────────────────────
  const gracePeriodMarginMs = 30 * 60 * 1000; // 30 minutes
  const cutoff = new Date(Date.now() - gracePeriodMarginMs);

  const stalePendingOrders = await Order.find({
    status: 'PENDING_PAYMENT',
    expiresAt: { $lt: cutoff },
  })
    .select('_id expiresAt')
    .limit(50)
    .lean();

  for (const order of stalePendingOrders) {
    violations.push({
      rule: 'STALE_PENDING_ORDER',
      targetId: order._id.toString(),
      details: {
        expiresAt: order.expiresAt,
      },
    });

    logger.warn(
      { orderId: order._id, expiresAt: order.expiresAt },
      'Stale order pending beyond TTL + grace margin; pending reconciliation',
    );
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}
