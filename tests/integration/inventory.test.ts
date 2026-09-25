import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { Inventory } from '@modules/inventory/models/inventory.model.js';
import { Reservation } from '@modules/inventory/models/reservation.model.js';
import {
  reserveStock,
  releaseReservation,
  commitReservation,
  sweepExpiredReservations,
} from '@modules/inventory/reservation.service.js';
import { setupTestReplSet, teardownTestReplSet, clearTestDatabase } from '../helpers/db.js';

describe('Inventory & Reservations (Scenario A + F)', () => {
  beforeAll(async () => {
    await setupTestReplSet();
    await Inventory.init();
    await Reservation.init();
  });

  afterAll(async () => {
    await teardownTestReplSet();
  });

  beforeEach(async () => {
    await clearTestDatabase();
  });

  const makeProduct = () => new Types.ObjectId();
  const makeOrder = () => new Types.ObjectId();

  async function seedInventory(productId: Types.ObjectId, onHand: number, reserved = 0) {
    return Inventory.create({ productId, onHand, reserved });
  }

  describe('reserveStock — Scenario A (atomic, no oversell)', () => {
    it('reserves stock and decrements available', async () => {
      const pId = makeProduct();
      await seedInventory(pId, 10, 0);

      const oId = makeOrder();
      await reserveStock(oId, [{ productId: pId, qty: 3 }]);

      const inv = await Inventory.findOne({ productId: pId });
      expect(inv?.reserved).toBe(3);
      expect(inv?.onHand).toBe(10); // onHand unchanged until commit

      const reservation = await Reservation.findOne({ orderId: oId });
      expect(reservation?.status).toBe('ACTIVE');
      expect(reservation?.items[0]?.qty).toBe(3);
    });

    it('throws when stock is insufficient (rejects the entire reservation)', async () => {
      const pId = makeProduct();
      await seedInventory(pId, 5, 0);

      const oId = makeOrder();
      await expect(
        reserveStock(oId, [{ productId: pId, qty: 10 }]), // 10 > 5
      ).rejects.toThrow(/insufficient stock/i);

      // Inventory must be unchanged after rollback
      const inv = await Inventory.findOne({ productId: pId });
      expect(inv?.reserved).toBe(0);

      // No reservation record created
      const res = await Reservation.findOne({ orderId: oId });
      expect(res).toBeNull();
    });

    it('rejects when available = onHand - reserved < qty (reserved already counted)', async () => {
      const pId = makeProduct();
      await seedInventory(pId, 10, 8); // only 2 available

      const oId = makeOrder();
      await expect(
        reserveStock(oId, [{ productId: pId, qty: 3 }]), // 3 > 2
      ).rejects.toThrow(/insufficient stock/i);
    });

    it('prevents overselling under concurrent load (Scenario A)', async () => {
      const pId = makeProduct();
      await seedInventory(pId, 5, 0); // only 5 units

      // 10 concurrent attempts for 1 unit each — only 5 should succeed
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => reserveStock(makeOrder(), [{ productId: pId, qty: 1 }])),
      );

      const successes = results.filter((r) => r.status === 'fulfilled');
      const failures = results.filter((r) => r.status === 'rejected');

      expect(successes).toHaveLength(5);
      expect(failures).toHaveLength(5);

      const inv = await Inventory.findOne({ productId: pId });
      expect(inv?.reserved).toBe(5); // exactly 5 reserved, never 6
      expect(inv?.onHand).toBe(5); // onHand unchanged
    });

    it('rolls back ALL items if any one item has insufficient stock (multi-item order)', async () => {
      const pA = makeProduct();
      const pB = makeProduct();
      await seedInventory(pA, 10, 0); // plenty
      await seedInventory(pB, 2, 0); // only 2

      const oId = makeOrder();
      await expect(
        reserveStock(oId, [
          { productId: pA, qty: 5 },
          { productId: pB, qty: 5 }, // insufficient — should roll back pA too
        ]),
      ).rejects.toThrow(/insufficient stock/i);

      const invA = await Inventory.findOne({ productId: pA });
      const invB = await Inventory.findOne({ productId: pB });

      // Both must be fully rolled back
      expect(invA?.reserved).toBe(0);
      expect(invB?.reserved).toBe(0);
    });
  });

  describe('commitReservation', () => {
    it('decrements onHand and reserved on commit', async () => {
      const pId = makeProduct();
      await seedInventory(pId, 10, 0);

      const oId = makeOrder();
      await reserveStock(oId, [{ productId: pId, qty: 3 }]);

      await commitReservation(oId);

      const inv = await Inventory.findOne({ productId: pId });
      expect(inv?.onHand).toBe(7); // onHand decremented
      expect(inv?.reserved).toBe(0); // reservation released

      const res = await Reservation.findOne({ orderId: oId });
      expect(res?.status).toBe('COMMITTED');
    });
  });

  describe('releaseReservation', () => {
    it('returns stock to available pool without modifying onHand', async () => {
      const pId = makeProduct();
      await seedInventory(pId, 10, 0);

      const oId = makeOrder();
      await reserveStock(oId, [{ productId: pId, qty: 4 }]);

      await releaseReservation(oId);

      const inv = await Inventory.findOne({ productId: pId });
      expect(inv?.onHand).toBe(10); // onHand unchanged
      expect(inv?.reserved).toBe(0); // reservation freed

      const res = await Reservation.findOne({ orderId: oId });
      expect(res?.status).toBe('RELEASED');
    });

    it('is idempotent — calling release twice does not double-decrement', async () => {
      const pId = makeProduct();
      await seedInventory(pId, 10, 0);

      const oId = makeOrder();
      await reserveStock(oId, [{ productId: pId, qty: 3 }]);

      await releaseReservation(oId); // first call
      await releaseReservation(oId); // second call — no-op

      const inv = await Inventory.findOne({ productId: pId });
      expect(inv?.reserved).toBe(0); // not negative
    });
  });

  describe('sweepExpiredReservations — Scenario F', () => {
    it('expires ACTIVE reservations past their TTL and restores available stock', async () => {
      const pId = makeProduct();
      await seedInventory(pId, 10, 0);

      const oId = makeOrder();
      await reserveStock(oId, [{ productId: pId, qty: 3 }]);

      // Manually expire the reservation
      await Reservation.updateOne({ orderId: oId }, { expiresAt: new Date(Date.now() - 1000) });

      const expired = await sweepExpiredReservations();
      expect(expired).toBe(1);

      const inv = await Inventory.findOne({ productId: pId });
      expect(inv?.reserved).toBe(0); // stock returned to pool

      const res = await Reservation.findOne({ orderId: oId });
      expect(res?.status).toBe('EXPIRED');
    });

    it('does not touch COMMITTED or RELEASED reservations', async () => {
      const pId = makeProduct();
      await seedInventory(pId, 10, 0);

      const oId1 = makeOrder();
      const oId2 = makeOrder();
      await reserveStock(oId1, [{ productId: pId, qty: 2 }]);
      await reserveStock(oId2, [{ productId: pId, qty: 2 }]);

      // Commit one, release the other
      await commitReservation(oId1);
      await releaseReservation(oId2);

      // Both past expiry time
      await Reservation.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });

      const expired = await sweepExpiredReservations();
      expect(expired).toBe(0); // nothing to sweep — no ACTIVE reservations

      const inv = await Inventory.findOne({ productId: pId });
      expect(inv?.reserved).toBe(0); // unchanged after commit + release
    });
  });

  describe('expireSingleReservation', () => {
    it('expires single active reservation when expired and restores stock', async () => {
      const pId = makeProduct();
      await seedInventory(pId, 10, 0);

      const oId = makeOrder();
      await reserveStock(oId, [{ productId: pId, qty: 4 }]);

      // Mark expired
      await Reservation.updateOne({ orderId: oId }, { expiresAt: new Date(Date.now() - 1000) });

      const { expireSingleReservation } = await import('@modules/inventory/reservation.service.js');
      const result = await expireSingleReservation(oId);
      expect(result).toBe(true);

      const inv = await Inventory.findOne({ productId: pId });
      expect(inv?.reserved).toBe(0);

      const res = await Reservation.findOne({ orderId: oId });
      expect(res?.status).toBe('EXPIRED');
    });

    it('returns false and does not expire if reservation is not yet expired', async () => {
      const pId = makeProduct();
      await seedInventory(pId, 10, 0);

      const oId = makeOrder();
      await reserveStock(oId, [{ productId: pId, qty: 4 }]);

      const { expireSingleReservation } = await import('@modules/inventory/reservation.service.js');
      const result = await expireSingleReservation(oId);
      expect(result).toBe(false);

      const inv = await Inventory.findOne({ productId: pId });
      expect(inv?.reserved).toBe(4); // still reserved

      const res = await Reservation.findOne({ orderId: oId });
      expect(res?.status).toBe('ACTIVE');
    });
  });
});
