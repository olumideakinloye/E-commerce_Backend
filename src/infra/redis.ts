import { Redis } from 'ioredis';
import { env } from '@config/env.js';
import { logger } from '@common/logger.js';

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null, // Required by BullMQ
      lazyConnect: true,
      retryStrategy(times) {
        const delay = Math.min(times * 100, 3000);
        return delay;
      },
    });

    redisClient.on('connect', () => {
      logger.info('Redis connected');
    });

    redisClient.on('ready', () => {
      logger.info('Redis ready');
    });

    redisClient.on('error', (err) => {
      logger.error({ err }, 'Redis error');
    });

    redisClient.on('close', () => {
      logger.warn('Redis connection closed');
    });
  }

  return redisClient;
}

export async function connectRedis(): Promise<Redis> {
  const client = getRedisClient();
  if (client.status === 'wait') {
    await client.connect();
  }
  return client;
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient && redisClient.status !== 'end') {
    await redisClient.quit();
    logger.info('Redis disconnected cleanly');
    redisClient = null;
  }
}

export async function checkRedisHealth(): Promise<boolean> {
  try {
    if (!redisClient || redisClient.status !== 'ready') return false;
    const pong = await redisClient.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}
