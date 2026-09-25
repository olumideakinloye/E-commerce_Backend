import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { buildApp } from '@/app.js';
import { User } from '@modules/auth/models/user.model.js';
import { Product } from '@modules/products/models/product.model.js';
import { Inventory } from '@modules/inventory/models/inventory.model.js';
import { signAccessToken } from '@common/utils/tokens.js';
import { setupTestReplSet, teardownTestReplSet, clearTestDatabase } from '../helpers/db.js';

describe('Products & Catalog (integration)', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let customerToken: string;
  let customerId: string;

  beforeAll(async () => {
    await setupTestReplSet();
    await User.init();
    await Product.init();
    await Inventory.init();

    app = buildApp() as unknown as FastifyInstance;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestReplSet();
  });

  beforeEach(async () => {
    await clearTestDatabase();

    // Create Admin user and token
    const adminUser = await User.create({
      email: 'admin@example.com',
      passwordHash: 'dummy-hash',
      role: 'admin',
      tokenVersion: 0,
    });
    adminToken = signAccessToken({
      sub: adminUser._id.toString(),
      role: 'admin',
      tokenVersion: 0,
    });

    // Create Customer user and token
    const customerUser = await User.create({
      email: 'customer@example.com',
      passwordHash: 'dummy-hash',
      role: 'customer',
      tokenVersion: 0,
    });
    customerId = customerUser._id.toString();
    customerToken = signAccessToken({
      sub: customerId,
      role: 'customer',
      tokenVersion: 0,
    });
  });

  const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

  describe('Admin Product Management & RBAC', () => {
    it('rejects unauthenticated and non-admin requests to admin endpoints', async () => {
      const payload = {
        name: 'Mechanical Keyboard',
        description: 'RGB mechanical gaming keyboard',
        priceMinor: 9999,
        category: 'electronics',
      };

      // Unauthenticated -> 401
      const resUnauth = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/products',
        payload,
      });
      expect(resUnauth.statusCode).toBe(401);

      // Customer role -> 403 Forbidden
      const resCustomer = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/products',
        payload,
        headers: authHeader(customerToken),
      });
      expect(resCustomer.statusCode).toBe(403);
    });

    it('allows admin to create a product with auto-generated slug and initial stock', async () => {
      const payload = {
        name: 'Wireless Mouse',
        description: 'Ergonomic 2.4G wireless optical mouse',
        priceMinor: 2999,
        currency: 'USD',
        category: 'electronics',
        tags: ['mouse', 'wireless'],
        initialStock: 15,
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/products',
        payload,
        headers: authHeader(adminToken),
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.slug).toBe('wireless-mouse');
      expect(body.version).toBe(1);
      expect(body.onHand).toBe(15);

      // Verify Inventory record was created
      const inv = await Inventory.findOne({ productId: new Types.ObjectId(body.id) });
      expect(inv).not.toBeNull();
      expect(inv?.onHand).toBe(15);
      expect(inv?.reserved).toBe(0);
    });

    it('bumps product.version when price changes, but not on non-price updates (Scenario B invariant)', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/products',
        payload: {
          name: 'Noise Cancelling Headphones',
          description: 'Over-ear headphones',
          priceMinor: 15000,
          category: 'audio',
          initialStock: 10,
        },
        headers: authHeader(adminToken),
      });
      expect(createRes.statusCode).toBe(201);
      const product = createRes.json();
      expect(product.version).toBe(1);

      // 1. Non-price update: description only
      const descRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/products/${product.id}`,
        payload: { description: 'Updated description with better specs' },
        headers: authHeader(adminToken),
      });
      expect(descRes.statusCode).toBe(200);
      expect(descRes.json().version).toBe(1); // Not bumped

      // 2. Price change: priceMinor 15000 -> 18000
      const priceRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/products/${product.id}`,
        payload: { priceMinor: 18000 },
        headers: authHeader(adminToken),
      });
      expect(priceRes.statusCode).toBe(200);
      expect(priceRes.json().version).toBe(2); // Bumped to 2!
      expect(priceRes.json().priceMinor).toBe(18000);
    });

    it('soft-deletes product via DELETE /admin/products/:id (never destroys historical reference)', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/products',
        payload: {
          name: 'Discontinued Item',
          description: 'Will be deleted soon',
          priceMinor: 500,
          category: 'clearance',
        },
        headers: authHeader(adminToken),
      });
      const productId = createRes.json().id;

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/products/${productId}`,
        headers: authHeader(adminToken),
      });
      expect(deleteRes.statusCode).toBe(200);

      // Product still exists in DB with isAvailable: false and archivedAt set
      const inDb = await Product.findById(productId);
      expect(inDb).not.toBeNull();
      expect(inDb?.isAvailable).toBe(false);
      expect(inDb?.archivedAt).not.toBeNull();

      // But public catalog does NOT return it
      const publicRes = await app.inject({
        method: 'GET',
        url: `/api/v1/products/${productId}`,
      });
      expect(publicRes.statusCode).toBe(404);
    });

    it('updates inventory onHand via PUT /admin/inventory/:productId', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/products',
        payload: {
          name: 'USB-C Cable',
          description: 'Braided cable 2m',
          priceMinor: 1200,
          category: 'accessories',
          initialStock: 2,
        },
        headers: authHeader(adminToken),
      });
      const productId = createRes.json().id;

      // Restock to 50
      const putRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/inventory/${productId}`,
        payload: { onHand: 50 },
        headers: authHeader(adminToken),
      });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.json().onHand).toBe(50);
      expect(putRes.json().available).toBe(50);

      // Verify public product shows stockStatus 'in_stock'
      const publicRes = await app.inject({
        method: 'GET',
        url: `/api/v1/products/${productId}`,
      });
      expect(publicRes.statusCode).toBe(200);
      expect(publicRes.json().stockStatus).toBe('in_stock');
    });
  });

  describe('Public Catalog & Keyset Pagination', () => {
    beforeEach(async () => {
      // Seed 5 test products
      for (let i = 1; i <= 5; i++) {
        const prod = await Product.create({
          name: `Gadget Item ${i}`,
          slug: `gadget-item-${i}`,
          description: `Description for item ${i} with electronic features`,
          priceMinor: i * 1000,
          currency: 'USD',
          category: i % 2 === 0 ? 'electronics' : 'home',
          tags: ['gadget'],
          isAvailable: true,
          version: 1,
        });
        await Inventory.create({
          productId: prod._id,
          onHand: i === 1 ? 0 : i === 2 ? 3 : 20, // out_of_stock, low_stock, in_stock
          reserved: 0,
        });
      }
    });

    it('lists products with keyset cursor pagination (limit 2)', async () => {
      // Page 1
      const page1Res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?limit=2&sort=price_asc',
      });
      expect(page1Res.statusCode).toBe(200);
      const page1 = page1Res.json();
      expect(page1.items).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();
      expect(page1.items[0].priceMinor).toBe(1000);
      expect(page1.items[1].priceMinor).toBe(2000);

      // Verify stock status band
      expect(page1.items[0].stockStatus).toBe('out_of_stock');
      expect(page1.items[0].inStock).toBe(false);
      expect(page1.items[1].stockStatus).toBe('low_stock');
      expect(page1.items[1].inStock).toBe(true);

      // Page 2 using cursor
      const page2Res = await app.inject({
        method: 'GET',
        url: `/api/v1/products?limit=2&sort=price_asc&cursor=${page1.nextCursor}`,
      });
      expect(page2Res.statusCode).toBe(200);
      const page2 = page2Res.json();
      expect(page2.items).toHaveLength(2);
      expect(page2.items[0].priceMinor).toBe(3000);
      expect(page2.items[1].priceMinor).toBe(4000);
      expect(page2.hasMore).toBe(true);
    });

    it('filters products by category', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?category=electronics',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.length).toBeGreaterThan(0);
      for (const item of body.items) {
        expect(item.category).toBe('electronics');
      }
    });

    it('supports ETag caching with 304 Not Modified on GET /products/:id', async () => {
      const anyProd = await Product.findOne();
      expect(anyProd).not.toBeNull();

      const res1 = await app.inject({
        method: 'GET',
        url: `/api/v1/products/${anyProd?._id.toString()}`,
      });
      expect(res1.statusCode).toBe(200);
      const etag = res1.headers['etag'];
      expect(etag).toBeDefined();
      expect(res1.headers['cache-control']).toBeDefined();

      // Request with If-None-Match
      const res2 = await app.inject({
        method: 'GET',
        url: `/api/v1/products/${anyProd?._id.toString()}`,
        headers: { 'if-none-match': etag as string },
      });
      expect(res2.statusCode).toBe(304);
      expect(res2.payload).toBe('');
    });
  });
});
