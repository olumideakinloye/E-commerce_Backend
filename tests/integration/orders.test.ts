import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { buildApp } from '@/app.js';
import { User } from '@modules/auth/models/user.model.js';
import { Order } from '@modules/orders/models/order.model.js';
import { setupTestReplSet, teardownTestReplSet, clearTestDatabase } from '../helpers/db.js';

describe('Orders — ownership / anti-IDOR (integration)', () => {
  let app: FastifyInstance;

  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/api/v1/auth${url}`, payload: payload as object });

  const get = (url: string, accessToken?: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/orders${url}`,
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : undefined,
    });

  const registerAndLogin = async (email: string) => {
    const creds = { email, password: 'correct-horse-battery' };
    await post('/register', creds);
    const res = await post('/login', creds);
    return res.json() as { accessToken: string; refreshToken: string };
  };

  const createOrderFor = async (userId: string) => {
    const productId = new mongoose.Types.ObjectId();
    const order = await Order.create({
      userId,
      status: 'PENDING_PAYMENT',
      lines: [
        {
          productId,
          name: 'Test Widget',
          unitPriceMinor: 1000,
          currency: 'USD',
          qty: 1,
          totalMinor: 1000,
        },
      ],
      totals: {
        subtotalMinor: 1000,
        taxMinor: 0,
        shippingMinor: 0,
        grandTotalMinor: 1000,
        currency: 'USD',
      },
      idempotencyKey: `test-${Date.now()}-${Math.random()}`,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
    return order.id as string;
  };

  beforeAll(async () => {
    await setupTestReplSet();
    await User.init();
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

  it('lets the owner fetch their own order', async () => {
    const owner = await registerAndLogin('owner@example.com');
    const decoded = JSON.parse(
      Buffer.from(owner.accessToken.split('.')[1] as string, 'base64url').toString(),
    ) as { sub: string };
    const orderId = await createOrderFor(decoded.sub);

    const res = await get(`/${orderId}`, owner.accessToken);

    expect(res.statusCode).toBe(200);
    expect(res.json().order._id).toBe(orderId);
  });

  it("returns 404 (never 403) when a different user requests someone else's order", async () => {
    const owner = await registerAndLogin('owner@example.com');
    const decoded = JSON.parse(
      Buffer.from(owner.accessToken.split('.')[1] as string, 'base64url').toString(),
    ) as { sub: string };
    const orderId = await createOrderFor(decoded.sub);

    const intruder = await registerAndLogin('intruder@example.com');
    const res = await get(`/${orderId}`, intruder.accessToken);

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('gives the same 404 for a nonexistent order id as for one owned by someone else', async () => {
    const owner = await registerAndLogin('owner@example.com');
    const decoded = JSON.parse(
      Buffer.from(owner.accessToken.split('.')[1] as string, 'base64url').toString(),
    ) as { sub: string };
    const realOrderId = await createOrderFor(decoded.sub);

    const intruder = await registerAndLogin('intruder@example.com');
    const otherUsersOrder = await get(`/${realOrderId}`, intruder.accessToken);
    const missingOrder = await get(`/${new mongoose.Types.ObjectId().toString()}`, intruder.accessToken);

    expect(otherUsersOrder.statusCode).toBe(missingOrder.statusCode);
    expect(otherUsersOrder.json().error.message).toBe(missingOrder.json().error.message);
  });

  it('returns 404, not 500, for a malformed order id', async () => {
    const owner = await registerAndLogin('owner@example.com');

    const res = await get('/not-a-valid-object-id', owner.accessToken);

    expect(res.statusCode).toBe(404);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await get(`/${new mongoose.Types.ObjectId().toString()}`);

    expect(res.statusCode).toBe(401);
  });
});
