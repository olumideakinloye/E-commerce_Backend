import { getRedisClient } from '@infra/redis.js';
import { logger } from '@common/logger.js';

export async function getCached<T>(key: string): Promise<T | null> {
  try {
    const client = getRedisClient();
    if (client.status !== 'ready') return null;
    const data = await client.get(key);
    if (!data) return null;
    return JSON.parse(data) as T;
  } catch (err) {
    logger.warn({ err, key }, 'Failed to read from Redis cache');
    return null;
  }
}

export async function setCached<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  try {
    const client = getRedisClient();
    if (client.status !== 'ready') return;
    await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn({ err, key }, 'Failed to write to Redis cache');
  }
}

export async function deleteCached(patternOrKey: string): Promise<void> {
  try {
    const client = getRedisClient();
    if (client.status !== 'ready') return;
    if (patternOrKey.includes('*')) {
      const keys = await client.keys(patternOrKey);
      if (keys.length > 0) {
        await client.del(...keys);
      }
    } else {
      await client.del(patternOrKey);
    }
  } catch (err) {
    logger.warn({ err, patternOrKey }, 'Failed to delete from Redis cache');
  }
}
