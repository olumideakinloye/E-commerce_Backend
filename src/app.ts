import fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { randomUUID } from 'node:crypto';
import { logger } from '@common/logger.js';
import { errorHandler, notFoundHandler } from '@common/error-handler.js';
import { checkMongoHealth } from '@infra/mongo.js';
import { checkRedisHealth } from '@infra/redis.js';

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
    disableRequestLogging: false,
  });

  // Security headers & CORS
  app.register(helmet, {
    contentSecurityPolicy: false, // Configurable for OpenAPI / Docs later
  });

  app.register(cors, {
    origin: true,
    credentials: true,
  });

  // Attach Request-ID to all responses
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // Error handling
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // Health checks
  app.get('/health/live', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  });

  app.get('/health/ready', async (_request, reply) => {
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

  return app;
}
