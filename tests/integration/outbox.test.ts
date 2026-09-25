/**
 * Outbox Processor Integration Tests
 *
 * Verifies that the outbox dispatcher correctly processes INITIATE_PAYMENT and
 * CLEAR_CART events, applies exponential backoff on failure, and marks events
 * FAILED after exhausting all retries (running the compensating action for
 * INITIATE_PAYMENT).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
import { setupTestReplSet, teardownTestReplSet, clearTestDatabase } from '../helpers/db.js';
import { Outbox } from '@modules/jobs/models/outbox.model.js';
import { Order } from '@modules/orders/models/order.model.js';
import { Payment } from '@modules/payments/models/payment.model.js';
import { Cart } from '@modules/cart/models/cart.model.js';
import { Inventory } from '@modules/inventory/models/inventory.model.js';
import { Reservation } from '@modules/inventory/models/reservation.model.js';
import { registerPaymentProvider } from '@modules/payments/providers/index.js';
import { startOutboxProcessor } from '@modules/jobs/outbox.processor.js';
import { Types } from 'mongoose';

// ─── Test helpers ─────────────────────────────────────────────────────────────

async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestReplSet();
}, 60_000);

afterAll(async () => {
  await teardownTestReplSet();
}, 30_000);

beforeEach(async () => {
  await clearTestDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Outbox Processor', () => {
  describe('CLEAR_CART event', () => {
    it('processes a CLEAR_CART event and clears the user cart', async () => {
      const userId = new Types.ObjectId().toString();

      // Seed a cart for the user
      await Cart.create({ userId: new Types.ObjectId(userId), items: [] });

      // Create a pending outbox event
      await Outbox.create({
        type: 'CLEAR_CART',
        payload: { userId },
        status: 'PENDING',
        nextAttemptAt: new Date(Date.now() - 1000), // due immediately
      });

      // Start the processor
      const processor = startOutboxProcessor();

      try {
        // Wait for the event to be COMPLETED
        await waitForCondition(async () => {
          const event = await Outbox.findOne({ type: 'CLEAR_CART' });
          return event?.status === 'COMPLETED';
        });

        const event = await Outbox.findOne({ type: 'CLEAR_CART' });
        expect(event?.status).toBe('COMPLETED');
        expect(event?.lastError).toBeNull();
      } finally {
        await processor.stop();
      }
    });

    it('retries a CLEAR_CART event that fails and eventually completes', async () => {
      const userId = new Types.ObjectId().toString();

      // Create the outbox event
      await Outbox.create({
        type: 'CLEAR_CART',
        payload: { userId },
        status: 'PENDING',
        nextAttemptAt: new Date(Date.now() - 1000),
        maxAttempts: 5,
      });

      // Mock Cart.findOneAndUpdate to fail once, then succeed
      let callCount = 0;
      const originalFindOneAndUpdate = Cart.findOneAndUpdate.bind(Cart);
      vi.spyOn(Cart, 'findOneAndUpdate').mockImplementation(((...args: unknown[]) => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Simulated DB transient failure')) as unknown;
        }
        return (originalFindOneAndUpdate as (...a: unknown[]) => unknown)(...args);
      }) as never);

      const processor = startOutboxProcessor();

      try {
        // After the first failure, the event should be rescheduled (PENDING) with lastError set
        await waitForCondition(async () => {
          const event = await Outbox.findOne({ type: 'CLEAR_CART' });
          return (
            event?.attempts !== undefined && event.attempts >= 1 && event.status !== 'COMPLETED'
          );
        });

        // Allow the mock to succeed on the next attempt
        await waitForCondition(async () => {
          const event = await Outbox.findOne({ type: 'CLEAR_CART' });
          return event?.status === 'COMPLETED';
        });

        const event = await Outbox.findOne({ type: 'CLEAR_CART' });
        expect(event?.status).toBe('COMPLETED');
        expect(event?.attempts).toBeGreaterThanOrEqual(2);
      } finally {
        await processor.stop();
      }
    });
  });

  describe('INITIATE_PAYMENT event', () => {
    it('processes an INITIATE_PAYMENT event successfully', async () => {
      const orderId = new Types.ObjectId();
      const userId = new Types.ObjectId();
      const paymentRef = `pay_test_${Date.now()}`;

      // Seed order in PENDING_PAYMENT state
      await Order.create({
        _id: orderId,
        userId,
        status: 'PENDING_PAYMENT',
        lines: [
          {
            productId: new Types.ObjectId(),
            name: 'Test Product',
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
        paymentRef,
        idempotencyKey: `idem_${Date.now()}`,
        expiresAt: new Date(Date.now() + 900_000),
      });

      // Seed payment record
      await Payment.create({
        orderId,
        provider: 'paystack',
        reference: paymentRef,
        status: 'INITIATED',
        amountMinor: 5000,
        currency: 'NGN',
      });

      // Create INITIATE_PAYMENT outbox event
      await Outbox.create({
        type: 'INITIATE_PAYMENT',
        payload: {
          orderId: orderId.toString(),
          paymentRef,
          amountMinor: 5000,
          currency: 'NGN',
          provider: 'paystack',
        },
        status: 'PENDING',
        nextAttemptAt: new Date(Date.now() - 1000),
      });

      const processor = startOutboxProcessor();

      try {
        await waitForCondition(async () => {
          const event = await Outbox.findOne({ type: 'INITIATE_PAYMENT' });
          return event?.status === 'COMPLETED';
        });

        const event = await Outbox.findOne({ type: 'INITIATE_PAYMENT' });
        expect(event?.status).toBe('COMPLETED');

        // Verify the authorization URL was stored
        const payment = await Payment.findOne({ reference: paymentRef });
        expect(payment?.authorizationUrl).toBeTruthy();
        expect(payment?.authorizationUrl).toContain(paymentRef);
      } finally {
        await processor.stop();
      }
    });

    it('compensates (PAYMENT_FAILED + release reservation) after exhausting INITIATE_PAYMENT retries', async () => {
      const orderId = new Types.ObjectId();
      const userId = new Types.ObjectId();
      const productId = new Types.ObjectId();
      const paymentRef = `pay_exhaust_${Date.now()}`;

      // Seed inventory
      await Inventory.create({
        productId,
        onHand: 10,
        reserved: 2,
      });

      // Seed reservation
      await Reservation.create({
        orderId,
        status: 'ACTIVE',
        items: [{ productId, qty: 2 }],
        expiresAt: new Date(Date.now() + 900_000),
      });

      // Seed order
      await Order.create({
        _id: orderId,
        userId,
        status: 'PENDING_PAYMENT',
        lines: [
          {
            productId,
            name: 'Test Product',
            unitPriceMinor: 1500,
            currency: 'NGN',
            qty: 2,
            totalMinor: 3000,
          },
        ],
        totals: {
          subtotalMinor: 3000,
          taxMinor: 0,
          shippingMinor: 0,
          grandTotalMinor: 3000,
          currency: 'NGN',
        },
        paymentRef,
        idempotencyKey: `idem_exhaust_${Date.now()}`,
        expiresAt: new Date(Date.now() + 900_000),
      });

      await Payment.create({
        orderId,
        provider: 'paystack',
        reference: paymentRef,
        status: 'INITIATED',
        amountMinor: 3000,
        currency: 'NGN',
      });

      // Register a mock provider that always fails
      registerPaymentProvider({
        name: 'paystack',
        async initialize() {
          throw new Error('Gateway unavailable');
        },
        async verify() {
          return { status: 'PENDING', amountMinor: 0, currency: 'NGN', reference: '' };
        },
        verifyWebhookSignature: () => false,
        parseWebhookEvent: () => {
          throw new Error('not implemented');
        },
      });

      // Create outbox event with maxAttempts = 2 to exhaust quickly
      await Outbox.create({
        type: 'INITIATE_PAYMENT',
        payload: {
          orderId: orderId.toString(),
          paymentRef,
          amountMinor: 3000,
          currency: 'NGN',
          provider: 'paystack',
        },
        status: 'PENDING',
        nextAttemptAt: new Date(Date.now() - 1000),
        maxAttempts: 2,
      });

      const processor = startOutboxProcessor();

      try {
        // Wait for the outbox event to reach FAILED state
        await waitForCondition(async () => {
          const event = await Outbox.findOne({ type: 'INITIATE_PAYMENT' });
          return event?.status === 'FAILED';
        }, 15_000);

        const event = await Outbox.findOne({ type: 'INITIATE_PAYMENT' });
        expect(event?.status).toBe('FAILED');
        expect(event?.attempts).toBeGreaterThanOrEqual(2);

        // Compensating action: order should be PAYMENT_FAILED
        await waitForCondition(async () => {
          const order = await Order.findById(orderId);
          return order?.status === 'PAYMENT_FAILED';
        }, 5_000);

        const finalOrder = await Order.findById(orderId);
        expect(finalOrder?.status).toBe('PAYMENT_FAILED');

        // Reservation should be released
        const reservation = await Reservation.findOne({ orderId });
        expect(reservation?.status).toBe('RELEASED');
      } finally {
        await processor.stop();
      }
    });
  });

  describe('Lease claiming prevents double-processing', () => {
    it('does not double-process the same event with two concurrent processor instances', async () => {
      const userId = new Types.ObjectId().toString();

      // Track how many times clearCart is called
      const clearCalls: string[] = [];
      const originalFindOneAndUpdate = Cart.findOneAndUpdate.bind(Cart);
      vi.spyOn(Cart, 'findOneAndUpdate').mockImplementation(((...args: unknown[]) => {
        clearCalls.push(userId);
        return (originalFindOneAndUpdate as (...a: unknown[]) => unknown)(...args);
      }) as never);

      await Outbox.create({
        type: 'CLEAR_CART',
        payload: { userId },
        status: 'PENDING',
        nextAttemptAt: new Date(Date.now() - 1000),
      });

      // Start two concurrent processors
      const proc1 = startOutboxProcessor();
      const proc2 = startOutboxProcessor();

      try {
        await waitForCondition(async () => {
          const event = await Outbox.findOne({ type: 'CLEAR_CART' });
          return event?.status === 'COMPLETED';
        });

        // Ensure there is exactly ONE completed event and the cart was cleared once
        const events = await Outbox.find({ type: 'CLEAR_CART' });
        expect(events).toHaveLength(1);
        expect(events[0]!.status).toBe('COMPLETED');
        expect(clearCalls).toHaveLength(1);
      } finally {
        await proc1.stop();
        await proc2.stop();
      }
    });
  });
});
