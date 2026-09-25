import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/app.js';
import { User } from '@modules/auth/models/user.model.js';
import { Product } from '@modules/products/models/product.model.js';
import { Inventory } from '@modules/inventory/models/inventory.model.js';
import { Reservation } from '@modules/inventory/models/reservation.model.js';
import { Payment } from '@modules/payments/models/payment.model.js';
import { Outbox } from '@modules/jobs/models/outbox.model.js';
import { Order } from '@modules/orders/models/order.model.js';
import { setupTestReplSet, teardownTestReplSet, clearTestDatabase } from '../helpers/db.js';

describe('Orders & Checkout (Phase 7 — Scenarios B & C)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestReplSet();
    await User.init();
    await Product.init();
    await Inventory.init();
    await Reservation.init();
    await Payment.init();
    await Outbox.init();
    await Order.init();
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

  const addItemToCart = async (token: string, productId: string, qty: number) => {
    return app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { authorization: `Bearer ${token}` },
      payload: { productId, qty },
    });
  };

  const checkout = async (token: string, payload: object, idempotencyKey?: string) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
    };
    if (idempotencyKey) {
      headers['idempotency-key'] = idempotencyKey;
    }

    return app.inject({
      method: 'POST',
      url: '/api/v1/orders/checkout',
      headers,
      payload,
    });
  };

  describe('Scenario B: Price changes while items sit in cart', () => {
    it('returns 409 PRICE_CHANGED if catalog price changed after user saw it', async () => {
      const user = await registerAndLogin('shopper1@example.com');
      const product = await createProductWithStock('Headphones', 'headphones', 5000, 10);

      // User adds to cart at 5000 minor ($50)
      await addItemToCart(user.accessToken, product._id.toString(), 1);

      // Admin raises price to 6000 ($60)
      await Product.updateOne({ _id: product._id }, { $set: { priceMinor: 6000 } });

      // User attempts checkout expecting $50 (5000)
      const res = await checkout(
        user.accessToken,
        {
          expectedTotalMinor: 5000,
          currency: 'USD',
        },
        'idem-key-1',
      );

      expect(res.statusCode).toBe(409);
      const json = res.json();
      expect(json.error.code).toBe('PRICE_CHANGED');
      expect(json.error.details.expectedTotalMinor).toBe(5000);
      expect(json.error.details.currentTotalMinor).toBe(6000);

      // Invariant: No order or reservation created on 409
      const orderCount = await Order.countDocuments();
      const resCount = await Reservation.countDocuments();
      expect(orderCount).toBe(0);
      expect(resCount).toBe(0);
    });

    it('succeeds when expectedTotal matches live price, preserving snapshotted price forever', async () => {
      const user = await registerAndLogin('shopper2@example.com');
      const product = await createProductWithStock('Keyboard', 'keyboard', 10000, 5);

      await addItemToCart(user.accessToken, product._id.toString(), 2); // 2 * 10000 = 20000

      const res = await checkout(
        user.accessToken,
        {
          expectedTotalMinor: 20000,
          currency: 'USD',
        },
        'idem-key-2',
      );

      expect(res.statusCode).toBe(201);
      const data = res.json();
      expect(data.order.status).toBe('PENDING_PAYMENT');
      expect(data.order.totals.grandTotalMinor).toBe(20000);
      expect(data.payment.reference).toMatch(/^pay_/);

      // Subsequent price change does NOT affect the snapshotted order line
      await Product.updateOne({ _id: product._id }, { $set: { priceMinor: 15000 } });

      const fetchedOrder = await Order.findById(data.order.id);
      expect(fetchedOrder?.lines[0]?.unitPriceMinor).toBe(10000);
      expect(fetchedOrder?.totals.grandTotalMinor).toBe(20000);
    });
  });

  describe('Scenario C: Idempotency & Partial failure atomicity', () => {
    it('requires Idempotency-Key header', async () => {
      const user = await registerAndLogin('shopper3@example.com');
      const product = await createProductWithStock('Mouse', 'mouse', 3000, 5);
      await addItemToCart(user.accessToken, product._id.toString(), 1);

      const res = await checkout(user.accessToken, {
        expectedTotalMinor: 3000,
        currency: 'USD',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
    });

    it('returns identical cached response on duplicate request with same key and body', async () => {
      const user = await registerAndLogin('shopper4@example.com');
      const product = await createProductWithStock('Monitor', 'monitor', 25000, 5);
      await addItemToCart(user.accessToken, product._id.toString(), 1);

      const payload = { expectedTotalMinor: 25000, currency: 'USD' };
      const key = 'idempotent-order-123';

      const firstRes = await checkout(user.accessToken, payload, key);
      expect(firstRes.statusCode).toBe(201);

      const secondRes = await checkout(user.accessToken, payload, key);
      expect(secondRes.statusCode).toBe(201);
      expect(secondRes.json()).toEqual(firstRes.json());

      // Only one order created in the database
      const count = await Order.countDocuments({ idempotencyKey: key });
      expect(count).toBe(1);
    });

    it('returns 422 if same idempotency key is reused with different payload', async () => {
      const user = await registerAndLogin('shopper5@example.com');
      const product = await createProductWithStock('Desk', 'desk', 50000, 5);
      await addItemToCart(user.accessToken, product._id.toString(), 1);

      const key = 'idempotent-order-456';
      await checkout(user.accessToken, { expectedTotalMinor: 50000, currency: 'USD' }, key);

      // Re-use key with different currency / payload
      const conflictRes = await checkout(
        user.accessToken,
        { expectedTotalMinor: 50000, currency: 'EUR' },
        key,
      );

      expect(conflictRes.statusCode).toBe(422);
      expect(conflictRes.json().error.code).toBe('UNPROCESSABLE_ENTITY');
    });

    it('atomically rolls back everything if inventory reservation fails', async () => {
      const user = await registerAndLogin('shopper6@example.com');
      // Stock is only 1
      const product = await createProductWithStock('Rare GPU', 'rare-gpu', 100000, 1);
      await addItemToCart(user.accessToken, product._id.toString(), 1);

      // Before checkout, another transaction consumes the last unit
      await Inventory.updateOne({ productId: product._id }, { $set: { reserved: 1 } });

      const res = await checkout(
        user.accessToken,
        { expectedTotalMinor: 100000, currency: 'USD' },
        'idem-rollback-key',
      );

      expect(res.statusCode).toBe(422);

      // Assert no orphaned order, payment, or outbox records were created
      const orderCount = await Order.countDocuments();
      const paymentCount = await Payment.countDocuments();
      const outboxCount = await Outbox.countDocuments();
      expect(orderCount).toBe(0);
      expect(paymentCount).toBe(0);
      expect(outboxCount).toBe(0);
    });
  });

  describe('Order queries & cancellation lifecycle', () => {
    it('lists user orders with keyset pagination', async () => {
      const user = await registerAndLogin('shopper7@example.com');
      const product = await createProductWithStock('USB Cable', 'usb-cable', 1000, 50);

      // Place 2 orders
      await addItemToCart(user.accessToken, product._id.toString(), 1);
      await checkout(user.accessToken, { expectedTotalMinor: 1000, currency: 'USD' }, 'o-1');

      await app.inject({
        method: 'DELETE',
        url: '/api/v1/cart',
        headers: { authorization: `Bearer ${user.accessToken}` },
      });

      await addItemToCart(user.accessToken, product._id.toString(), 2);
      await checkout(user.accessToken, { expectedTotalMinor: 2000, currency: 'USD' }, 'o-2');

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/orders',
        headers: { authorization: `Bearer ${user.accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.orders).toHaveLength(2);
      expect(json.hasMore).toBe(false);
    });

    it('cancels pending order and releases reserved stock', async () => {
      const user = await registerAndLogin('shopper8@example.com');
      const product = await createProductWithStock('Webcam', 'webcam', 8000, 5);
      await addItemToCart(user.accessToken, product._id.toString(), 2);

      const checkoutRes = await checkout(
        user.accessToken,
        { expectedTotalMinor: 16000, currency: 'USD' },
        'cancel-test-key',
      );
      const orderId = checkoutRes.json().order.id;

      // Stock is currently reserved
      let inv = await Inventory.findOne({ productId: product._id });
      expect(inv?.reserved).toBe(2);

      // Cancel order
      const cancelRes = await app.inject({
        method: 'POST',
        url: `/api/v1/orders/${orderId}/cancel`,
        headers: { authorization: `Bearer ${user.accessToken}` },
      });

      expect(cancelRes.statusCode).toBe(200);
      expect(cancelRes.json().order.status).toBe('CANCELLED');

      // Reserved stock returned to pool
      inv = await Inventory.findOne({ productId: product._id });
      expect(inv?.reserved).toBe(0);

      const reservation = await Reservation.findOne({ orderId });
      expect(reservation?.status).toBe('RELEASED');
    });
  });
});
