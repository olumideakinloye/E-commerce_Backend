import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '@/app.js';
import type { FastifyInstance } from 'fastify';

describe('Health and System Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp() as unknown as FastifyInstance;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live should return 200 with status ok and x-request-id header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBeDefined();

    const payload = JSON.parse(response.payload);
    expect(payload.status).toBe('ok');
    expect(payload.timestamp).toBeDefined();
  });

  it('GET /health/ready should respond with checks structure', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/ready',
    });

    // In a test without live DB, ready can return 503, but checks must be structured
    expect([200, 503]).toContain(response.statusCode);
    const payload = JSON.parse(response.payload);
    expect(payload.checks).toBeDefined();
    expect(payload.checks.mongo).toBeDefined();
    expect(payload.checks.redis).toBeDefined();
  });

  it('Unmatched routes should return consistent 404 error envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/non-existent-endpoint',
    });

    expect(response.statusCode).toBe(404);
    const payload = JSON.parse(response.payload);
    expect(payload.error).toBeDefined();
    expect(payload.error.code).toBe('NOT_FOUND');
    expect(payload.error.requestId).toBeDefined();
  });
});
