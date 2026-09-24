import { buildApp } from './app.js';
import { env } from '@config/env.js';
import { logger } from '@common/logger.js';
import { connectMongo, disconnectMongo } from '@infra/mongo.js';
import { connectRedis, disconnectRedis } from '@infra/redis.js';

async function bootstrap(): Promise<void> {
  // Connect to persistent databases
  try {
    await connectMongo();
  } catch (err) {
    logger.error(
      { err },
      'Could not connect to MongoDB on startup. Continuing for readiness probe to handle.',
    );
  }

  try {
    await connectRedis();
  } catch (err) {
    logger.error(
      { err },
      'Could not connect to Redis on startup. Continuing for readiness probe to handle.',
    );
  }

  const app = buildApp();

  let isShuttingDown = false;

  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}. Starting graceful shutdown...`);

    // Force exit if graceful shutdown takes longer than 10 seconds
    const forceExitTimer = setTimeout(() => {
      logger.error('Graceful shutdown timed out. Forcing exit.');
      process.exit(1);
    }, 10000);
    forceExitTimer.unref();

    try {
      logger.info('Closing HTTP server...');
      await app.close();

      logger.info('Disconnecting Redis...');
      await disconnectRedis();

      logger.info('Disconnecting MongoDB...');
      await disconnectMongo();

      logger.info('Graceful shutdown completed successfully.');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    logger.info(`Server listening on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

void bootstrap();
