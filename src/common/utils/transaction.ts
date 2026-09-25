import mongoose, { type ClientSession } from 'mongoose';
import { type TransactionOptions } from 'mongodb';
import { logger } from '@common/logger.js';

export interface RetryableTransactionOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  transactionOptions?: TransactionOptions;
}

const DEFAULT_TRANSACTION_OPTIONS: TransactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
};

/**
 * Execute a unit of work inside a MongoDB transaction with automatic retries
 * on transient transaction errors, write conflicts, or commit uncertainties.
 * Uses exponential backoff with full jitter to avoid stampedes.
 */
export async function withRetryableTransaction<T>(
  work: (session: ClientSession) => Promise<T>,
  options: RetryableTransactionOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 1000;
  const txOptions = options.transactionOptions ?? DEFAULT_TRANSACTION_OPTIONS;

  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxRetries) {
    attempt++;
    const session = await mongoose.startSession();

    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await work(session);
      }, txOptions);

      return result;
    } catch (err: unknown) {
      lastError = err;

      const isTransient =
        isTransientError(err) ||
        (err instanceof Error &&
          (err.name === 'MongoServerError' || err.name === 'MongoError') &&
          'code' in err &&
          ((err as { code: number }).code === 112 || (err as { code: number }).code === 251));

      if (!isTransient || attempt >= maxRetries) {
        logger.error(
          { attempt, maxRetries, err },
          'Transaction failed permanently or non-transient error encountered',
        );
        throw err;
      }

      // Exponential backoff with full jitter
      const expDelay = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempt - 1));
      const jitteredDelay = Math.floor(Math.random() * expDelay);

      logger.warn(
        { attempt, maxRetries, retryInMs: jitteredDelay, err },
        'Transient transaction error; retrying with backoff',
      );

      await new Promise((resolve) => setTimeout(resolve, jitteredDelay));
    } finally {
      await session.endSession();
    }
  }

  throw lastError;
}

function isTransientError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const errorObj = err as Record<string, unknown>;

  if (Array.isArray(errorObj.errorLabels)) {
    return (
      errorObj.errorLabels.includes('TransientTransactionError') ||
      errorObj.errorLabels.includes('UnknownTransactionCommitResult')
    );
  }

  return false;
}
