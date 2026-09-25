/**
 * Phase 10: E2E Happy-Path Test
 *
 * Scenario: A customer completes the full purchase journey end-to-end.
 *   1. Admin creates a product with stock
 *   2. Customer registers and logs in
 *   3. Customer browses catalog (ETag caching)
 *   4. Customer adds item to cart
 *   5. Customer checks out (idempotent) → order PENDING_PAYMENT
 *   6. Payment gateway webhook fires charge.success → order transitions to PAID
 *   7. Customer verifies payment via verify-payment endpoint → PAID confirmed
 *   8. Inventory committed (onHand decreased, reserved released)
 *   9. Duplicate webhook is a no-op (idempotent processing)
 */

import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '@/app.js';
import { User } from '@modules/auth/models/user.model.js';
import { Product } from '@modules/products/models/product.model.js';
import { Inventory } from '@modules/inventory/models/inventory.model.js';
import { Reservation } from '@modules/inventory/models/reservation.model.js';
import { Payment } from '@modules/payments/models/payment.model.js';
import { Order } from '@modules/orders/models/order.model.js';
import { WebhookEvent } from '@modules/payments/models/webhook-event.model.js';
import { Outbox } from '@modules/jobs/models/outbox.model.js';
import { env } from '@config/env.js';
import { setupTestReplSet, teardownTestReplSet, clearTestDatabase } from '../helpers/db.js';
import { signAccessToken } from '@common/utils/tokens.js';

describe('E2E Happy Path: Register → Browse → Cart → Checkout → Webhook → PAID', () => {
  let app: ReturnType<typeof buildApp>;
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
    await Outbox.init();
    app = buildApp();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardownTestReplSet();
  }, 30_000);

  beforeEach(async () => {
    await clearTestDatabase();
  });

  it('completes the full purchase journey from registration to PAID order', async () => {
    // ─── Step 1: Admin creates a product with stock ────────────────────────────
    const adminUser = await User.create({
      email: 'admin@store.com',
      passwordHash: 'dummy',
      role: 'admin',
      tokenVersion: 0,
    });
    const adminToken = signAccessToken({
      sub: adminUser._id.toString(),
      role: 'admin',
      tokenVersion: 0,
    });

    const createProductRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Wireless Headphones',
        description: 'Premium noise-cancelling headphones',
        priceMinor: 15000,
        currency: 'NGN',
        category: 'electronics',
        initialStock: 10,
      },
    });

    expect(createProductRes.statusCode).toBe(201);
    const { id: productId } = createProductRes.json();

    // Verify inventory was initialised
    const inv = await Inventory.findOne({ productId });
    expect(inv?.onHand).toBe(10);
    expect(inv?.reserved).toBe(0);

    // ─── Step 2: Customer registers ───────────────────────────────────────────
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'buyer@example.com', password: 'StrongPass123!' },
    });
    expect(registerRes.statusCode).toBe(201);

    // ─── Step 3: Customer logs in ──────────────────────────────────────────────
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'buyer@example.com', password: 'StrongPass123!' },
    });
    expect(loginRes.statusCode).toBe(200);
    const { accessToken } = loginRes.json() as { accessToken: string };

    // ─── Step 4: Customer browses catalog ─────────────────────────────────────
    const catalogRes = await app.inject({
      method: 'GET',
      url: '/api/v1/products',
    });
    expect(catalogRes.statusCode).toBe(200);
    const catalog = catalogRes.json() as { items: Array<{ id: string; name: string }> };
    expect(catalog.items.length).toBeGreaterThanOrEqual(1);
    expect(catalog.items.some((p) => p.name === 'Wireless Headphones')).toBe(true);

    // Browse single product (ETag caching)
    const productRes = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${productId}`,
    });
    expect(productRes.statusCode).toBe(200);
    const etag = productRes.headers['etag'];
    expect(etag).toBeTruthy();

    // Conditional GET should return 304
    const conditionalRes = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${productId}`,
      headers: { 'if-none-match': etag as string },
    });
    expect(conditionalRes.statusCode).toBe(304);

    // ─── Step 5: Customer adds item to cart ───────────────────────────────────
    const addToCartRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { productId, qty: 2 },
    });
    expect(addToCartRes.statusCode).toBe(200);

    // Verify cart state
    const cartRes = await app.inject({
      method: 'GET',
      url: '/api/v1/cart',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(cartRes.statusCode).toBe(200);
    const cart = cartRes.json() as { items: Array<{ qty: number }> };
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]!.qty).toBe(2);

    // ─── Step 6: Customer checks out ──────────────────────────────────────────
    const idempotencyKey = `e2e-checkout-${Date.now()}`;
    const checkoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/checkout',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        expectedTotalMinor: 30000, // 2 × 15000
        currency: 'NGN',
      },
    });
    expect(checkoutRes.statusCode).toBe(201);
    const checkoutBody = checkoutRes.json() as {
      order: { id: string; status: string };
      payment: { reference: string };
    };

    expect(checkoutBody.order.status).toBe('PENDING_PAYMENT');
    const orderId = checkoutBody.order.id;
    const paymentRef = checkoutBody.payment.reference;

    // Verify reservation created
    const reservation = await Reservation.findOne({ orderId });
    expect(reservation?.status).toBe('ACTIVE');
    expect(reservation?.items[0]?.qty).toBe(2);

    // Idempotent re-checkout returns the same order
    const checkoutResAgain = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/checkout',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        expectedTotalMinor: 30000,
        currency: 'NGN',
      },
    });
    expect([200, 201]).toContain(checkoutResAgain.statusCode); // 200 or 201 on replay
    expect(checkoutResAgain.json().order.id).toBe(orderId);

    // ─── Step 7: Payment gateway fires charge.success webhook ─────────────────
    const webhookPayload = {
      event: 'charge.success',
      data: {
        id: 'evt_e2e_charge_success',
        reference: paymentRef,
        amount: 30000,
        currency: 'NGN',
        status: 'success',
        customer: { email: 'buyer@example.com' },
      },
    };
    const bodyStr = JSON.stringify(webhookPayload);
    const signature = crypto.createHmac('sha512', webhookSecret).update(bodyStr).digest('hex');

    const webhookRes = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/paystack',
      headers: {
        'x-paystack-signature': signature,
        'content-type': 'application/json',
      },
      body: bodyStr,
    });
    expect(webhookRes.statusCode).toBe(200);
    expect(webhookRes.json().received).toBe(true);

    // ─── Step 8: Order is now PAID ────────────────────────────────────────────
    const orderRes = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${orderId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(orderRes.statusCode).toBe(200);
    expect(orderRes.json().order.status).toBe('PAID');

    // ─── Step 9: Verify via verify-payment endpoint ───────────────────────────
    const verifyRes = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${orderId}/verify-payment`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(verifyRes.statusCode).toBe(200);
    const verifyBody = verifyRes.json() as {
      order: { status: string };
      payment: { status: string };
    };
    expect(verifyBody.order.status).toBe('PAID');
    expect(verifyBody.payment.status).toBe('SUCCESS');

    // ─── Step 10: Inventory committed ─────────────────────────────────────────
    const finalInv = await Inventory.findOne({ productId });
    expect(finalInv?.onHand).toBe(8); // 10 - 2
    expect(finalInv?.reserved).toBe(0); // released

    // ─── Step 11: Duplicate webhook is idempotent ─────────────────────────────
    const duplicateWebhookRes = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/paystack',
      headers: {
        'x-paystack-signature': signature,
        'content-type': 'application/json',
      },
      body: bodyStr,
    });
    expect(duplicateWebhookRes.statusCode).toBe(200);
    expect(duplicateWebhookRes.json().status).toBe('DUPLICATE');

    // Order must remain PAID (not double-transitioned)
    const finalOrder = await Order.findById(orderId);
    expect(finalOrder?.status).toBe('PAID');
  });
});
