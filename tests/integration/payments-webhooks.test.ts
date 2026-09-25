import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/app.js';
import { User } from '@modules/auth/models/user.model.js';
import { Product } from '@modules/products/models/product.model.js';
import { Inventory } from '@modules/inventory/models/inventory.model.js';
import { Reservation } from '@modules/inventory/models/reservation.model.js';
import { Payment } from '@modules/payments/models/payment.model.js';
import { Order } from '@modules/orders/models/order.model.js';
import { WebhookEvent } from '@modules/payments/models/webhook-event.model.js';
import { env } from '@config/env.js';
import { registerPaymentProvider, getPaymentProvider } from '@modules/payments/providers/index.js';
import type {
  PaymentProvider,
  VerifyPaymentResult,
  InitializePaymentParams,
} from '@modules/payments/provider.interface.js';
import { reconcilePendingOrders } from '@modules/payments/payments.service.js';
import { setupTestReplSet, teardownTestReplSet, clearTestDatabase } from '../helpers/db.js';

describe('Payments & Webhooks (Phase 8 — Scenarios D & E)', () => {
  let app: FastifyInstance;
  const webhookSecret = env.PAYSTACK_SECRET_KEY || env.PAYMENT_WEBHOOK_SECRET;

  beforeAll(async () => {
    await setupTestReplSet();
    await User.init();
    await Product.init();
    await Inventory.init();
    await Reservation.init();
    await Payment.init();
    await Order.init();
    await WebhookEvent.init();
    app = buildApp() as unknown as FastifyInstance;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestReplSet();
  });

  beforeEach(async () => {
    await clearTestDatabase();
  });

  const registerAndLogin = async (email: string) => {
    const creds = { email, password: 'correct-horse-battery' };
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: creds });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: creds });
    return res.json() as { accessToken: string };
  };

  const createProductWithStock = async (
    name: string,
    slug: string,
    priceMinor: number,
    onHand: number,
  ) => {
    const product = await Product.create({
      name,
      slug,
      description: `${name} description`,
      priceMinor,
      currency: 'USD',
      category: 'Electronics',
      tags: ['gadget'],
      isAvailable: true,
      version: 1,
    });

    await Inventory.create({
      productId: product._id,
      onHand,
      reserved: 0,
    });

    return product;
  };

  const placeOrder = async (token: string, productId: string, qty: number, priceMinor: number) => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { authorization: `Bearer ${token}` },
      payload: { productId, qty },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/checkout',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': `idem-${Date.now()}-${Math.random()}`,
      },
      payload: {
        expectedTotalMinor: priceMinor * qty,
        currency: 'USD',
      },
    });

    return res.json() as {
      order: { id: string; status: string };
      payment: { reference: string };
    };
  };

  const generatePaystackSignature = (payload: object) => {
    const bodyStr = JSON.stringify(payload);
    return {
      bodyStr,
      signature: crypto.createHmac('sha512', webhookSecret).update(bodyStr).digest('hex'),
    };
  };

  describe('Webhook Security & HMAC Verification', () => {
    it('rejects webhooks with invalid HMAC signature with 401', async () => {
      const payload = { event: 'charge.success', data: { reference: 'pay_invalid' } };
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/paystack',
        headers: {
          'x-paystack-signature': 'invalid_fake_signature_hex_value',
          'content-type': 'application/json',
        },
        payload,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    });

    it('rejects webhooks with missing signature header with 401', async () => {
      const payload = { event: 'charge.success', data: { reference: 'pay_invalid' } };
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/paystack',
        headers: { 'content-type': 'application/json' },
        payload,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('Scenario E: Webhook processing and Duplicate idempotency', () => {
    it('transitions order to PAID and commits stock on valid charge.success', async () => {
      const user = await registerAndLogin('payer1@example.com');
      const product = await createProductWithStock('Camera', 'camera', 20000, 5);
      const checkoutResult = await placeOrder(user.accessToken, product._id.toString(), 2, 20000);

      const ref = checkoutResult.payment.reference;
      const orderId = checkoutResult.order.id;

      // Assert initial stock state: 5 onHand, 2 reserved
      let inv = await Inventory.findOne({ productId: product._id });
      expect(inv?.onHand).toBe(5);
      expect(inv?.reserved).toBe(2);

      const webhookPayload = {
        event: 'charge.success',
        data: {
          id: 'evt_1001',
          reference: ref,
          amount: 40000,
          currency: 'USD',
          status: 'success',
        },
      };

      const { bodyStr, signature } = generatePaystackSignature(webhookPayload);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/paystack',
        headers: {
          'content-type': 'application/json',
          'x-paystack-signature': signature,
        },
        payload: bodyStr,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('PROCESSED');

      // Assert Order updated to PAID
      const updatedOrder = await Order.findById(orderId);
      expect(updatedOrder?.status).toBe('PAID');

      // Assert Payment updated to SUCCESS
      const updatedPayment = await Payment.findOne({ reference: ref });
      expect(updatedPayment?.status).toBe('SUCCESS');

      // Assert Inventory COMMITTED: onHand decremented to 3, reserved to 0
      inv = await Inventory.findOne({ productId: product._id });
      expect(inv?.onHand).toBe(3);
      expect(inv?.reserved).toBe(0);

      // Assert Reservation marked COMMITTED
      const reservation = await Reservation.findOne({ orderId });
      expect(reservation?.status).toBe('COMMITTED');
    });

    it('suppresses duplicate concurrent webhooks (Scenario E) with zero extra stock deductions', async () => {
      const user = await registerAndLogin('payer2@example.com');
      const product = await createProductWithStock('Lens', 'lens', 15000, 10);
      const checkoutResult = await placeOrder(user.accessToken, product._id.toString(), 1, 15000);

      const ref = checkoutResult.payment.reference;
      const orderId = checkoutResult.order.id;

      const webhookPayload = {
        event: 'charge.success',
        data: {
          id: 'evt_duplicate_test',
          reference: ref,
          amount: 15000,
          currency: 'USD',
          status: 'success',
        },
      };

      const { bodyStr, signature } = generatePaystackSignature(webhookPayload);

      // Fire 5 identical webhooks concurrently
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          app.inject({
            method: 'POST',
            url: '/api/v1/webhooks/paystack',
            headers: {
              'content-type': 'application/json',
              'x-paystack-signature': signature,
            },
            payload: bodyStr,
          }),
        ),
      );

      // All 5 must respond with 200 OK
      for (const res of responses) {
        expect(res.statusCode).toBe(200);
      }

      // Exactly ONE processed, others detected as DUPLICATE
      const statuses = responses.map((r) => r.json().status);
      expect(statuses.filter((s) => s === 'PROCESSED')).toHaveLength(1);
      expect(statuses.filter((s) => s === 'DUPLICATE')).toHaveLength(4);

      // Inventory invariant: only 1 unit deducted (10 -> 9, reserved -> 0)
      const inv = await Inventory.findOne({ productId: product._id });
      expect(inv?.onHand).toBe(9);
      expect(inv?.reserved).toBe(0);

      const updatedOrder = await Order.findById(orderId);
      expect(updatedOrder?.status).toBe('PAID');
    });

    it('flags suspicious amount mismatch without marking order PAID or committing stock', async () => {
      const user = await registerAndLogin('payer3@example.com');
      const product = await createProductWithStock('Drone', 'drone', 80000, 5);
      const checkoutResult = await placeOrder(user.accessToken, product._id.toString(), 1, 80000);

      const ref = checkoutResult.payment.reference;
      const orderId = checkoutResult.order.id;

      // Attacker sends charge.success for only 100 minor ($1) instead of 80000 ($800)
      const tamperedPayload = {
        event: 'charge.success',
        data: {
          id: 'evt_tampered_1',
          reference: ref,
          amount: 100, // Fraudulent amount
          currency: 'USD',
          status: 'success',
        },
      };

      const { bodyStr, signature } = generatePaystackSignature(tamperedPayload);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/paystack',
        headers: {
          'content-type': 'application/json',
          'x-paystack-signature': signature,
        },
        payload: bodyStr,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('SUSPICIOUS_AMOUNT');

      // Invariant: Order must NOT be marked PAID
      const order = await Order.findById(orderId);
      expect(order?.status).toBe('PENDING_PAYMENT');

      // Inventory remains reserved, onHand untouched
      const inv = await Inventory.findOne({ productId: product._id });
      expect(inv?.onHand).toBe(5);
      expect(inv?.reserved).toBe(1);
    });

    it('releases reserved stock when charge.failed webhook is received', async () => {
      const user = await registerAndLogin('payer4@example.com');
      const product = await createProductWithStock('Tablet', 'tablet', 30000, 4);
      const checkoutResult = await placeOrder(user.accessToken, product._id.toString(), 1, 30000);

      const ref = checkoutResult.payment.reference;
      const orderId = checkoutResult.order.id;

      const failedPayload = {
        event: 'charge.failed',
        data: {
          id: 'evt_fail_1',
          reference: ref,
          amount: 30000,
          currency: 'USD',
          status: 'failed',
        },
      };

      const { bodyStr, signature } = generatePaystackSignature(failedPayload);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/paystack',
        headers: {
          'content-type': 'application/json',
          'x-paystack-signature': signature,
        },
        payload: bodyStr,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('PROCESSED');

      const order = await Order.findById(orderId);
      expect(order?.status).toBe('PAYMENT_FAILED');

      // Reserved stock returned to available pool
      const inv = await Inventory.findOne({ productId: product._id });
      expect(inv?.onHand).toBe(4);
      expect(inv?.reserved).toBe(0);

      const resDoc = await Reservation.findOne({ orderId });
      expect(resDoc?.status).toBe('RELEASED');
    });

    it('does not demote a PAID order if an out-of-order charge.failed event arrives later', async () => {
      const user = await registerAndLogin('payer5@example.com');
      const product = await createProductWithStock('Speaker', 'speaker', 12000, 3);
      const checkoutResult = await placeOrder(user.accessToken, product._id.toString(), 1, 12000);

      const ref = checkoutResult.payment.reference;
      const orderId = checkoutResult.order.id;

      // 1. Success event arrives first
      const successPayload = {
        event: 'charge.success',
        data: { id: 'evt_success_first', reference: ref, amount: 12000, currency: 'USD' },
      };
      const successData = generatePaystackSignature(successPayload);
      await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/paystack',
        headers: {
          'content-type': 'application/json',
          'x-paystack-signature': successData.signature,
        },
        payload: successData.bodyStr,
      });

      // 2. Delayed out-of-order failed event arrives later
      const delayedFailedPayload = {
        event: 'charge.failed',
        data: { id: 'evt_delayed_fail', reference: ref, amount: 12000, currency: 'USD' },
      };
      const failedData = generatePaystackSignature(delayedFailedPayload);
      await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/paystack',
        headers: {
          'content-type': 'application/json',
          'x-paystack-signature': failedData.signature,
        },
        payload: failedData.bodyStr,
      });

      // State machine invariant: Order remains PAID
      const order = await Order.findById(orderId);
      expect(order?.status).toBe('PAID');
    });
  });

  describe('Scenario D: User abandons browser & Payment Reconciliation', () => {
    it('reconciles abandoned pending order when gateway reports SUCCESS', async () => {
      const user = await registerAndLogin('payer6@example.com');
      const product = await createProductWithStock('Smart Watch', 'smart-watch', 25000, 5);
      const checkoutResult = await placeOrder(user.accessToken, product._id.toString(), 1, 25000);

      const ref = checkoutResult.payment.reference;
      const orderId = checkoutResult.order.id;

      // Register a mock provider that reports SUCCESS on verify
      const mockProvider: PaymentProvider = {
        name: 'paystack',
        initialize: async (p: InitializePaymentParams) => ({
          reference: p.reference,
          authorizationUrl: `https://checkout.test/${p.reference}`,
        }),
        verify: async (reference: string): Promise<VerifyPaymentResult> => ({
          status: 'SUCCESS',
          amountMinor: 25000,
          currency: 'USD',
          reference,
        }),
        verifyWebhookSignature: () => true,
        parseWebhookEvent: () => ({
          eventId: 'mock',
          eventType: 'charge.success',
          reference: ref,
          amountMinor: 25000,
          currency: 'USD',
          rawPayload: {},
        }),
      };
      registerPaymentProvider(mockProvider);

      // Backdate order createdAt to 10 minutes ago
      await Order.updateOne(
        { _id: orderId },
        { $set: { createdAt: new Date(Date.now() - 10 * 60 * 1000) } },
        { timestamps: false },
      );

      const summary = await reconcilePendingOrders(0);
      expect(summary.paidCount).toBe(1);

      const order = await Order.findById(orderId);
      expect(order?.status).toBe('PAID');

      const inv = await Inventory.findOne({ productId: product._id });
      expect(inv?.onHand).toBe(4);
      expect(inv?.reserved).toBe(0);

      // Restore original paystack provider
      const original = getPaymentProvider('paystack');
      registerPaymentProvider(original);
    });

    it('verifies order payment via active callback endpoint GET /orders/:id/verify-payment', async () => {
      const user = await registerAndLogin('payer7@example.com');
      const product = await createProductWithStock('Earbuds', 'earbuds', 10000, 5);
      const checkoutResult = await placeOrder(user.accessToken, product._id.toString(), 1, 10000);

      const ref = checkoutResult.payment.reference;
      const orderId = checkoutResult.order.id;

      const mockProvider: PaymentProvider = {
        name: 'paystack',
        initialize: async (p: InitializePaymentParams) => ({
          reference: p.reference,
          authorizationUrl: `https://checkout.test/${p.reference}`,
        }),
        verify: async (reference: string): Promise<VerifyPaymentResult> => ({
          status: 'SUCCESS',
          amountMinor: 10000,
          currency: 'USD',
          reference,
        }),
        verifyWebhookSignature: () => true,
        parseWebhookEvent: () => ({
          eventId: 'mock',
          eventType: 'charge.success',
          reference: ref,
          amountMinor: 10000,
          currency: 'USD',
          rawPayload: {},
        }),
      };
      registerPaymentProvider(mockProvider);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/orders/${orderId}/verify-payment`,
        headers: { authorization: `Bearer ${user.accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.order.status).toBe('PAID');
      expect(data.payment.status).toBe('SUCCESS');

      // Verify stock was committed
      const inv = await Inventory.findOne({ productId: product._id });
      expect(inv?.onHand).toBe(4);
      expect(inv?.reserved).toBe(0);

      const original = getPaymentProvider('paystack');
      registerPaymentProvider(original);
    });
  });
});
