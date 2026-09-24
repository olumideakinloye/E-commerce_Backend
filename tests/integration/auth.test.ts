import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/app.js';
import { User } from '@modules/auth/models/user.model.js';
import { RefreshToken } from '@modules/auth/models/refresh-token.model.js';
import { setupTestReplSet, teardownTestReplSet, clearTestDatabase } from '../helpers/db.js';

const creds = { email: 'bob@example.com', password: 'correct-horse-battery' };

describe('Auth (integration)', () => {
  let app: FastifyInstance;

  const post = (url: string, payload: unknown, headers?: Record<string, string>) =>
    app.inject({ method: 'POST', url: `/api/v1/auth${url}`, payload: payload as object, headers });

  const registerAndLogin = async () => {
    await post('/register', creds);
    const res = await post('/login', creds);
    return res.json() as { accessToken: string; refreshToken: string };
  };

  beforeAll(async () => {
    await setupTestReplSet();
    await User.init(); // make sure the unique indexes exist before we test them
    await RefreshToken.init();
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

  it('normalises email: registering "BOB@Example.com " then logging in with lowercase works', async () => {
    const reg = await post('/register', { ...creds, email: '  BOB@Example.com ' });
    expect(reg.statusCode).toBe(201);
    const login = await post('/login', creds);
    expect(login.statusCode).toBe(200);
  });

  it('rejects a duplicate email with 409, including concurrent registrations', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => post('/register', creds)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(4); // never a 500
  });

  it('does not accept a client-supplied role', async () => {
    const res = await post('/register', { ...creds, role: 'admin' });
    expect(res.statusCode).toBe(400);
  });

  it('gives an identical error for unknown email and wrong password', async () => {
    await post('/register', creds);
    const unknown = await post('/login', { email: 'nobody@example.com', password: 'whatever-123' });
    const wrong = await post('/login', { email: creds.email, password: 'wrong-password-1' });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json().error.message).toBe(wrong.json().error.message);
  });

  it('refresh rotates: 10 concurrent refreshes of one token yield exactly one success', async () => {
    const { refreshToken } = await registerAndLogin();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => post('/refresh', { refreshToken })),
    );
    const ok = results.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(1);
    for (const r of results.filter((r) => r.statusCode !== 200)) {
      expect([401, 403]).toContain(r.statusCode);
    }
  });

  it('reusing a rotated refresh token revokes the whole family', async () => {
    const { refreshToken } = await registerAndLogin();
    const first = await post('/refresh', { refreshToken });
    const newToken = first.json().refreshToken as string;

    const reuse = await post('/refresh', { refreshToken }); // old token again
    expect(reuse.statusCode).toBe(403);

    const afterRevoke = await post('/refresh', { refreshToken: newToken });
    expect(afterRevoke.statusCode).toBe(403); // family is dead, including the newest token
  });

  it('logout-all invalidates access tokens AND refresh tokens', async () => {
    const { accessToken, refreshToken } = await registerAndLogin();

    const out = await post('/logout-all', {}, { authorization: `Bearer ${accessToken}` });
    expect(out.statusCode).toBe(204);

    const refreshed = await post('/refresh', { refreshToken });
    expect(refreshed.statusCode).not.toBe(200);

    const again = await post('/logout-all', {}, { authorization: `Bearer ${accessToken}` });
    expect(again.statusCode).toBe(401); // old access token is dead
  });
});
