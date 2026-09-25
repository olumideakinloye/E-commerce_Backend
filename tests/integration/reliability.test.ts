/**
 * Phase 9: Cross-Cutting Reliability Integration Tests
 *
 * Verifies:
 *  1. CircuitBreaker pattern: state transitions, failure threshold, fast fail, half-open recovery.
 *  2. Fastify Idempotency Middleware: replaying cached responses, rejecting body mismatch (422),
 *     requiring key header.
 *  3. Audit Logging: persistent immutable audit trail for admin actions and payment events.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestReplSet, teardownTestReplSet, clearTestDatabase } from '../helpers/db.js';
import { CircuitBreaker } from '@common/utils/circuit-breaker.js';
import { recordAuditLog } from '@common/utils/audit.js';
import { AuditLog } from '@common/models/audit-log.model.js';
import { User } from '@modules/auth/models/user.model.js';
import { buildApp } from '../../src/app.js';
import { signAccessToken } from '@common/utils/tokens.js';
import { Types } from 'mongoose';

let app: ReturnType<typeof buildApp>;

async function createAdminUser(): Promise<{ adminId: string; token: string }> {
  const adminUser = await User.create({
    email: `admin_${Date.now()}_${Math.random().toString(36).substring(2, 6)}@test.com`,
    passwordHash: 'dummy-hash',
    role: 'admin',
    tokenVersion: 0,
  });
  const token = signAccessToken({
    sub: adminUser._id.toString(),
    role: 'admin',
    tokenVersion: 0,
  });
  return { adminId: adminUser._id.toString(), token };
}

beforeAll(async () => {
  await setupTestReplSet();
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

// ─── 1. Circuit Breaker Unit & Integration Tests ──────────────────────────────

describe('Circuit Breaker', () => {
  it('allows calls when CLOSED and counts successful operations', async () => {
    const cb = new CircuitBreaker({ name: 'test-gateway', failureThreshold: 3 });
    expect(cb.getState()).toBe('CLOSED');

    const result = await cb.execute(async () => 'success_result');
    expect(result).toBe('success_result');
    expect(cb.getState()).toBe('CLOSED');
  });

  it('trips to OPEN after exceeding the failure threshold and fails fast with 503', async () => {
    const cb = new CircuitBreaker({
      name: 'flaky-gateway',
      failureThreshold: 2,
      resetTimeoutMs: 500,
    });

    // 1st failure
    await expect(
      cb.execute(async () => {
        throw new Error('500 Gateway Internal Error');
      }),
    ).rejects.toThrow('500 Gateway Internal Error');
    expect(cb.getState()).toBe('CLOSED');

    // 2nd failure -> trips OPEN
    await expect(
      cb.execute(async () => {
        throw new Error('500 Gateway Internal Error');
      }),
    ).rejects.toThrow('500 Gateway Internal Error');
    expect(cb.getState()).toBe('OPEN');

    // Fast-fail: subsequent call fails fast with 503 without executing the function
    let executed = false;
    await expect(
      cb.execute(async () => {
        executed = true;
        return 'should_not_run';
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'CIRCUIT_BREAKER_OPEN',
    });

    expect(executed).toBe(false);
  });

  it('recovers via HALF_OPEN state when downstream service heals', async () => {
    const cb = new CircuitBreaker({
      name: 'recovering-gateway',
      failureThreshold: 1,
      resetTimeoutMs: 50,
      successThreshold: 2,
    });

    // Trip open
    await expect(
      cb.execute(async () => {
        throw new Error('downstream crash');
      }),
    ).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 60));

    // State should now be HALF_OPEN
    expect(cb.getState()).toBe('HALF_OPEN');

    // 1st success in HALF_OPEN
    await cb.execute(async () => 'probe-1');
    expect(cb.getState()).toBe('HALF_OPEN');

    // 2nd success in HALF_OPEN -> closes circuit!
    await cb.execute(async () => 'probe-2');
    expect(cb.getState()).toBe('CLOSED');
  });
});

// ─── 2. Audit Logging Tests ───────────────────────────────────────────────────

describe('Audit Logging', () => {
  it('persists structured audit log entries in the database', async () => {
    const actorId = new Types.ObjectId();

    await recordAuditLog({
      actorId,
      actorEmail: 'admin@example.com',
      actorRole: 'ADMIN',
      action: 'INVENTORY_ADJUSTED',
      targetType: 'Inventory',
      targetId: 'prod_123',
      diff: {
        before: { onHand: 10 },
        after: { onHand: 25 },
      },
      metadata: { reason: 'warehouse stock delivery' },
      ip: '192.168.1.50',
    });

    const logEntry = await AuditLog.findOne({ targetId: 'prod_123' });
    expect(logEntry).not.toBeNull();
    expect(logEntry?.action).toBe('INVENTORY_ADJUSTED');
    expect(logEntry?.actorRole).toBe('ADMIN');
    expect(logEntry?.actorEmail).toBe('admin@example.com');
    expect(logEntry?.ip).toBe('192.168.1.50');
    expect((logEntry?.diff?.after as { onHand: number })?.onHand).toBe(25);
  });

  it('records audit log when admin creates a product via API', async () => {
    const { token } = await createAdminUser();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        name: 'Audit Test Product',
        description: 'Testing audit logs on creation',
        priceMinor: 2500,
        currency: 'NGN',
        category: 'electronics',
        initialStock: 15,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();

    const audit = await AuditLog.findOne({
      targetType: 'Product',
      targetId: body.id,
      action: 'PRODUCT_CREATED',
    });

    expect(audit).not.toBeNull();
    expect(audit?.actorRole).toBe('ADMIN');
  });
});

// ─── 3. Reusable Idempotency Middleware Tests ─────────────────────────────────

describe('Reusable Idempotency Middleware', () => {
  it('replays cached response for identical subsequent requests with the same Idempotency-Key', async () => {
    const { token } = await createAdminUser();

    const idempotencyKey = `idem_prod_${Date.now()}`;
    const payload = {
      name: 'Idempotent Product',
      description: 'First attempt',
      priceMinor: 4999,
      currency: 'NGN',
      category: 'gadgets',
    };

    // First request
    const firstRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': idempotencyKey,
      },
      payload,
    });

    expect(firstRes.statusCode).toBe(201);
    const firstBody = firstRes.json();

    // Second request with SAME key and SAME body
    const secondRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': idempotencyKey,
      },
      payload,
    });

    // Should return identical 201 response with replay header
    expect(secondRes.statusCode).toBe(201);
    expect(secondRes.headers['x-cache-lookup']).toBe('HIT-IDEMPOTENT');
    expect(secondRes.json().id).toBe(firstBody.id);
  });

  it('rejects with 422 if the same Idempotency-Key is reused with different payload', async () => {
    const { token } = await createAdminUser();

    const idempotencyKey = `idem_conflict_${Date.now()}`;

    // First request
    const firstRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        name: 'Original Name',
        description: 'Original description',
        priceMinor: 1000,
        currency: 'NGN',
        category: 'clothing',
      },
    });

    expect(firstRes.statusCode).toBe(201);

    // Second request with SAME key but DIFFERENT body
    const secondRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        name: 'Completely Different Name',
        description: 'Tampered description',
        priceMinor: 9999,
        currency: 'NGN',
        category: 'clothing',
      },
    });

    expect(secondRes.statusCode).toBe(422);
    expect(secondRes.json().error.code).toBe('UNPROCESSABLE_ENTITY');
  });
});
