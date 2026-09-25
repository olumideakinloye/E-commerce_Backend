/**
 * Phase 10: Security RBAC Matrix Tests
 *
 * Validates that every route enforces the correct authorization level:
 *   - Public endpoints: no authentication required
 *   - Customer endpoints: require authenticated user
 *   - Admin endpoints: require admin role
 *   - Anti-IDOR: customers cannot access other customers' resources
 *   - Privilege escalation: customers cannot use admin endpoints
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '@/app.js';
import { User } from '@modules/auth/models/user.model.js';
import { Product } from '@modules/products/models/product.model.js';
import { Inventory } from '@modules/inventory/models/inventory.model.js';
import { Order } from '@modules/orders/models/order.model.js';
import { Payment } from '@modules/payments/models/payment.model.js';
import { Reservation } from '@modules/inventory/models/reservation.model.js';
import { Outbox } from '@modules/jobs/models/outbox.model.js';
import { setupTestReplSet, teardownTestReplSet, clearTestDatabase } from '../helpers/db.js';
import { signAccessToken } from '@common/utils/tokens.js';
import type { Types } from 'mongoose';

describe('Security RBAC Matrix (Phase 10)', () => {
  let app: ReturnType<typeof buildApp>;
  let adminToken: string;
  let customerAToken: string;
  let customerBToken: string;
  let productId: string;
  let customerAOrderId: string;

  beforeAll(async () => {
    await setupTestReplSet();
    await User.init();
    await Product.init();
    await Inventory.init();
    await Order.init();
    await Payment.init();
    await Reservation.init();
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

    // Set up admin
    const admin = await User.create({
      email: 'admin@rbac.com',
      passwordHash: 'dummy',
      role: 'admin',
      tokenVersion: 0,
    });
    adminToken = signAccessToken({
      sub: (admin._id as Types.ObjectId).toString(),
      role: 'admin',
      tokenVersion: 0,
    });

    // Set up customer A
    const customerA = await User.create({
      email: 'customer_a@rbac.com',
      passwordHash: 'dummy',
      role: 'customer',
      tokenVersion: 0,
    });
    customerAToken = signAccessToken({
      sub: (customerA._id as Types.ObjectId).toString(),
      role: 'customer',
      tokenVersion: 0,
    });

    // Set up customer B
    const customerB = await User.create({
      email: 'customer_b@rbac.com',
      passwordHash: 'dummy',
      role: 'customer',
      tokenVersion: 0,
    });
    customerBToken = signAccessToken({
      sub: (customerB._id as Types.ObjectId).toString(),
      role: 'customer',
      tokenVersion: 0,
    });

    // Create a product
    const product = await Product.create({
      name: 'RBAC Test Product',
      slug: `rbac-product-${Date.now()}`,
      description: 'RBAC test',
      priceMinor: 1000,
      currency: 'NGN',
      category: 'test',
      tags: [],
      isAvailable: true,
      version: 1,
    });
    productId = (product._id as Types.ObjectId).toString();
    await Inventory.create({ productId: product._id, onHand: 5, reserved: 0 });

    // Customer A places an order
    await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { authorization: `Bearer ${customerAToken}` },
      payload: { productId, qty: 1 },
    });
    const checkoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/checkout',
      headers: {
        authorization: `Bearer ${customerAToken}`,
        'idempotency-key': `rbac-setup-${Date.now()}`,
      },
      payload: { expectedTotalMinor: 1000, currency: 'NGN' },
    });
    customerAOrderId = (checkoutRes.json() as { order: { id: string } }).order.id;
  });

  // ─── 1. Public Routes ─────────────────────────────────────────────────────────

  describe('Public routes (no auth required)', () => {
    it('GET /api/v1/products returns 200 without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/products' });
      expect(res.statusCode).toBe(200);
    });

    it(`GET /api/v1/products/:id returns 200 without auth`, async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/products/${productId}` });
      expect(res.statusCode).toBe(200);
    });

    it('GET /health/live returns 200 without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/live' });
      expect(res.statusCode).toBe(200);
    });
  });

  // ─── 2. Auth-Required Routes ──────────────────────────────────────────────────

  describe('Customer-only routes reject unauthenticated requests', () => {
    it('GET /api/v1/cart returns 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/cart' });
      expect(res.statusCode).toBe(401);
    });

    it('POST /api/v1/cart/items returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/cart/items',
        payload: { productId, qty: 1 },
      });
      expect(res.statusCode).toBe(401);
    });

    it('POST /api/v1/orders/checkout returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/checkout',
        headers: { 'idempotency-key': 'test-key' },
        payload: { expectedTotalMinor: 1000, currency: 'NGN' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('GET /api/v1/orders returns 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/orders' });
      expect(res.statusCode).toBe(401);
    });
  });

  // ─── 3. Admin-Only Routes Reject Customers ────────────────────────────────────

  describe('Admin routes reject customer tokens', () => {
    it('POST /admin/products returns 403 for customer', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/products',
        headers: { authorization: `Bearer ${customerAToken}` },
        payload: {
          name: 'Unauthorized Product',
          description: 'test',
          priceMinor: 500,
          currency: 'NGN',
          category: 'test',
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('PATCH /admin/products/:id returns 403 for customer', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/products/${productId}`,
        headers: { authorization: `Bearer ${customerAToken}` },
        payload: { priceMinor: 9999 },
      });
      expect(res.statusCode).toBe(403);
    });

    it('DELETE /admin/products/:id returns 403 for customer', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/products/${productId}`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('PUT /admin/inventory/:productId returns 403 for customer', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/inventory/${productId}`,
        headers: { authorization: `Bearer ${customerAToken}` },
        payload: { onHand: 100 },
      });
      expect(res.statusCode).toBe(403);
    });

    it('POST /admin/products returns 401 without any token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/products',
        payload: {
          name: 'Unauthorized Product',
          description: 'test',
          priceMinor: 500,
          currency: 'NGN',
          category: 'test',
        },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ─── 4. Admin Routes Work for Admins ─────────────────────────────────────────

  describe('Admin routes accept admin tokens', () => {
    it('POST /admin/products returns 201 for admin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Admin Created Product',
          description: 'test',
          priceMinor: 2000,
          currency: 'NGN',
          category: 'electronics',
        },
      });
      expect(res.statusCode).toBe(201);
    });

    it('PUT /admin/inventory/:productId returns 200 for admin', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/inventory/${productId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { onHand: 20 },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ─── 5. Anti-IDOR: Customer B Cannot See Customer A's Orders ─────────────────

  describe('Anti-IDOR: customers cannot access other customers resources', () => {
    it("customer B gets 404 when accessing customer A's order by ID", async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/orders/${customerAOrderId}`,
        headers: { authorization: `Bearer ${customerBToken}` },
      });
      // Should be 404 (not found for this user), not 403 (to avoid leaking existence)
      expect(res.statusCode).toBe(404);
    });

    it("customer B gets 404 when trying to cancel customer A's order", async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/orders/${customerAOrderId}/cancel`,
        headers: { authorization: `Bearer ${customerBToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it("customer B's order list is empty (cannot see customer A's orders)", async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/orders',
        headers: { authorization: `Bearer ${customerBToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { orders: unknown[] };
      expect(body.orders).toHaveLength(0);
    });
  });

  // ─── 6. Token Validation ──────────────────────────────────────────────────────

  describe('Token validation rejects malformed or tampered tokens', () => {
    it('returns 401 for a completely invalid token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cart',
        headers: { authorization: 'Bearer this.is.not.a.valid.jwt' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 for a tampered token payload', async () => {
      // Take a valid token, decode the payload, tamper with role, re-encode
      const [header, , sig] = customerAToken.split('.');
      const tamperedPayload = Buffer.from(
        JSON.stringify({ sub: 'fake-user-id', role: 'admin', tokenVersion: 0 }),
      ).toString('base64url');
      const tamperedToken = `${header}.${tamperedPayload}.${sig}`;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cart',
        headers: { authorization: `Bearer ${tamperedToken}` },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
