import fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { logger } from '@common/logger.js';
import { errorHandler, notFoundHandler } from '@common/error-handler.js';
import { checkMongoHealth } from '@infra/mongo.js';
import { checkRedisHealth, getRedisClient } from '@infra/redis.js';
import { env } from '@config/env.js';
import { authRoutes } from '@modules/auth/auth.routes.js';
import { orderRoutes } from '@modules/orders/orders.routes.js';

export function buildApp() {
  const app = fastify({
    loggerInstance: logger,
    requestIdHeader: 'x-request-id',
    genReqId: (req) => {
      const incomingId = req.headers['x-request-id'];
      if (typeof incomingId === 'string' && incomingId.trim().length > 0) {
        return incomingId;
      }
      return randomUUID();
    },
  });

  // Security headers & CORS
  app.register(helmet, {
    contentSecurityPolicy: false,
  });

  app.register(cors, {
    origin: true,
    credentials: true,
  });

  // Global rate limit (Redis-backed when available, in-memory fallback)
  app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: env.RATE_LIMIT_GLOBAL_WINDOW_MS,
    redis: env.NODE_ENV === 'test' ? undefined : getRedisClient(),
    keyGenerator: (request) => request.user?.id ?? (request.ip || 'unknown'),
    errorResponseBuilder: (_request, context) => ({
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: `Rate limit exceeded. Retry after ${context.after}`,
        requestId: _request.id,
      },
    }),
  });

  // Attach Request-ID to all responses
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // Error handling
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // Health checks (excluded from rate limiting)
  app.get('/health/live', { config: { rateLimit: false } }, async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  });

  app.get('/health/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    const [mongoOk, redisOk] = await Promise.all([checkMongoHealth(), checkRedisHealth()]);

    const isReady = mongoOk && redisOk;
    const statusCode = isReady ? 200 : 503;

    return reply.status(statusCode).send({
      status: isReady ? 'ready' : 'not_ready',
      checks: {
        mongo: mongoOk ? 'up' : 'down',
        redis: redisOk ? 'up' : 'down',
      },
      timestamp: new Date().toISOString(),
    });
  });

  // Auth routes with strict rate limiting
  app.register(authRoutes, {
    prefix: '/api/v1/auth',
  });

  // Order routes (owner-scoped; see common/ownership.ts for the anti-IDOR pattern)
  app.register(orderRoutes, {
    prefix: '/api/v1/orders',
  });

  return app;
}
