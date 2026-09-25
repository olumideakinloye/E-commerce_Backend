/**
 * Invariant Checker Integration Tests (Phase 13)
 *
 * Verifies that the invariant checker correctly detects stock out of bounds
 * and uncommitted reservations on PAID orders.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { Inventory } from '@modules/inventory/models/inventory.model.js';
import { Order } from '@modules/orders/models/order.model.js';
import { Reservation } from '@modules/inventory/models/reservation.model.js';
import { runInvariantChecks } from '@modules/jobs/invariant-checker.js';
import { setupTestReplSet, teardownTestReplSet, clearTestDatabase } from '../helpers/db.js';

describe('Database Invariant Checker (Phase 13)', () => {
  beforeAll(async () => {
    await setupTestReplSet();
    await Inventory.init();
    await Order.init();
    await Reservation.init();
  });

  afterAll(async () => {
    await teardownTestReplSet();
  });

  beforeEach(async () => {
    await clearTestDatabase();
  });

  it('passes cleanly when database state obeys all invariants', async () => {
    const prodId = new Types.ObjectId();
    await Inventory.create({ productId: prodId, onHand: 10, reserved: 2 });

    const result = await runInvariantChecks();
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('detects and flags stock invariant violation when reserved > onHand', async () => {
    const prodId = new Types.ObjectId();
    // Deliberately corrupted row: reserved exceeds onHand
    await Inventory.create({ productId: prodId, onHand: 5, reserved: 8 });

    const result = await runInvariantChecks();
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === 'INVENTORY_STOCK_BOUNDS')).toBe(true);
  });

  it('detects uncommitted reservation for a PAID order', async () => {
    const orderId = new Types.ObjectId();
    const userId = new Types.ObjectId();

    await Order.create({
      _id: orderId,
      userId,
      status: 'PAID',
      lines: [
        {
          productId: new Types.ObjectId(),
          name: 'Test Item',
          unitPriceMinor: 5000,
          currency: 'NGN',
          qty: 1,
          totalMinor: 5000,
        },
      ],
      totals: {
        subtotalMinor: 5000,
        taxMinor: 0,
        shippingMinor: 0,
        grandTotalMinor: 5000,
        currency: 'NGN',
      },
      paymentRef: 'pay_test_inv',
      idempotencyKey: 'idem_inv_1',
      expiresAt: new Date(Date.now() + 60000),
    });

    // Deliberately corrupted state: order is PAID but reservation is still ACTIVE
    await Reservation.create({
      orderId,
      status: 'ACTIVE',
      items: [
        {
          productId: new Types.ObjectId(),
          qty: 1,
        },
      ],
      expiresAt: new Date(Date.now() + 60000),
    });

    const result = await runInvariantChecks();
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === 'PAID_ORDER_UNCOMMITTED_RESERVATION')).toBe(
      true,
    );
  });
});
