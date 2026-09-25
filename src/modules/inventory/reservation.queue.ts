import { Queue, Worker, type Job } from 'bullmq';
import { getRedisClient } from '@infra/redis.js';
import { logger } from '@common/logger.js';
import { env } from '@config/env.js';
import { expireSingleReservation, sweepExpiredReservations } from './reservation.service.js';

export const RESERVATION_EXPIRY_QUEUE_NAME = 'reservation-expiry';

export interface ReservationExpiryJobData {
  orderId: string;
}

let expiryQueue: Queue<ReservationExpiryJobData> | null = null;
let expiryWorker: Worker<ReservationExpiryJobData> | null = null;
let sweeperInterval: NodeJS.Timeout | null = null;

/**
 * Returns the BullMQ queue for reservation expiry jobs.
 * Lazily initialized if Redis is ready and not in test environment.
 */
export function getReservationExpiryQueue(): Queue<ReservationExpiryJobData> | null {
  if (env.NODE_ENV === 'test') {
    return null;
  }

  if (!expiryQueue) {
    const client = getRedisClient();
    if (client.status !== 'ready') {
      return null;
    }

    try {
      expiryQueue = new Queue<ReservationExpiryJobData>(RESERVATION_EXPIRY_QUEUE_NAME, {
        connection: client.duplicate(),
        defaultJobOptions: {
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      });
      logger.info('Reservation expiry BullMQ queue initialized');
    } catch (err) {
      logger.warn({ err }, 'Failed to initialize BullMQ reservation expiry queue');
      return null;
    }
  }

  return expiryQueue;
}

/**
 * Schedule a delayed job to expire a reservation when its TTL elapses.
 * Fails safely if Redis or Queue is unavailable (relying on the periodic DB sweeper).
 */
export async function scheduleReservationExpiry(orderId: string, delayMs: number): Promise<void> {
  const queue = getReservationExpiryQueue();
  if (!queue) {
    return;
  }

  try {
    await queue.add(
      'expire-reservation',
      { orderId },
      {
        delay: delayMs,
        jobId: `reservation:${orderId}`,
      },
    );
    logger.debug({ orderId, delayMs }, 'Scheduled delayed reservation expiry job');
  } catch (err) {
    logger.warn(
      { err, orderId },
      'Failed to schedule delayed reservation expiry job (will rely on periodic sweeper)',
    );
  }
}

/**
 * Start the BullMQ worker for reservation expiry.
 */
export function startReservationWorker(): Worker<ReservationExpiryJobData> | null {
  if (env.NODE_ENV === 'test') {
    return null;
  }

  if (!expiryWorker) {
    const client = getRedisClient();
    if (client.status !== 'ready') {
      return null;
    }

    try {
      expiryWorker = new Worker<ReservationExpiryJobData>(
        RESERVATION_EXPIRY_QUEUE_NAME,
        async (job: Job<ReservationExpiryJobData>) => {
          const { orderId } = job.data;
          logger.info({ orderId }, 'Processing reservation expiry job');
          const expired = await expireSingleReservation(orderId);
          if (expired) {
            logger.info({ orderId }, 'Successfully expired reservation and released stock');
          }
        },
        {
          connection: client.duplicate(),
          concurrency: 5,
        },
      );

      expiryWorker.on('failed', (job, err) => {
        logger.error({ jobId: job?.id, err }, 'Reservation expiry worker job failed');
      });

      logger.info('Reservation expiry BullMQ worker started');
    } catch (err) {
      logger.warn({ err }, 'Failed to start BullMQ reservation worker');
      return null;
    }
  }

  return expiryWorker;
}

/**
 * Start periodic DB sweeper for expired reservations (Scenario F safety net).
 * Runs every intervalMs (defaults to 60,000ms = 1 minute).
 */
export function startReservationSweeper(intervalMs = 60000): NodeJS.Timeout | null {
  if (sweeperInterval) {
    return sweeperInterval;
  }

  sweeperInterval = setInterval(async () => {
    try {
      const sweptCount = await sweepExpiredReservations();
      if (sweptCount > 0) {
        logger.info({ sweptCount }, 'Reservation sweeper expired active reservations');
      }
    } catch (err) {
      logger.error({ err }, 'Error running reservation sweeper');
    }
  }, intervalMs);

  // Unref so the interval doesn't hold node process alive on shutdown
  sweeperInterval.unref();
  return sweeperInterval;
}

/**
 * Stop sweeper, queue, and worker during graceful shutdown.
 */
export async function stopReservationQueueAndWorker(): Promise<void> {
  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
  }

  if (expiryWorker) {
    await expiryWorker.close();
    expiryWorker = null;
  }

  if (expiryQueue) {
    await expiryQueue.close();
    expiryQueue = null;
  }
}
