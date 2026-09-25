/**
 * Lightweight in-memory Circuit Breaker
 *
 * Protects downstream external dependencies (payment gateways, third-party APIs)
 * from cascade failures and avoids wasting resources when a downstream service is down.
 *
 * States:
 *  - CLOSED: Normal operation. All calls pass through. Failures are counted.
 *  - OPEN: Downstream is failing. Calls fail fast with a 503 without executing.
 *  - HALF_OPEN: Probe interval elapsed. One or more trial requests are allowed through.
 *               If they succeed, state returns to CLOSED; if any fails, trips back to OPEN.
 */

import { AppError } from '@common/errors.js';
import { logger } from '@common/logger.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold?: number; // Number of failures to trip open (default: 5)
  resetTimeoutMs?: number; // Time to wait in OPEN before trying HALF_OPEN (default: 30,000ms)
  successThreshold?: number; // Consecutive successes in HALF_OPEN to close (default: 2)
}

export class CircuitBreaker {
  public readonly name: string;
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private nextAttempt = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.successThreshold = options.successThreshold ?? 2;
  }

  public getState(): CircuitState {
    if (this.state === 'OPEN' && Date.now() >= this.nextAttempt) {
      this.state = 'HALF_OPEN';
      this.successCount = 0;
      logger.info({ circuit: this.name }, 'Circuit breaker transitioned to HALF_OPEN');
    }
    return this.state;
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === 'OPEN') {
      const retryAfterSec = Math.max(1, Math.ceil((this.nextAttempt - Date.now()) / 1000));
      logger.warn({ circuit: this.name, retryAfterSec }, 'Circuit breaker is OPEN — fast failing');
      throw new AppError(
        `Service '${this.name}' is temporarily unavailable (circuit breaker open). Retry later.`,
        503,
        'CIRCUIT_BREAKER_OPEN',
        { circuit: this.name, retryAfterSeconds: retryAfterSec },
      );
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        logger.info({ circuit: this.name }, 'Circuit breaker CLOSED after recovery');
      }
    } else if (this.state === 'CLOSED') {
      this.failureCount = 0;
    }
  }

  private onFailure(err: unknown): void {
    this.failureCount++;
    logger.warn(
      {
        circuit: this.name,
        state: this.state,
        failureCount: this.failureCount,
        threshold: this.failureThreshold,
        err,
      },
      'Circuit breaker recorded a failure',
    );

    if (this.state === 'HALF_OPEN' || this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.resetTimeoutMs;
      logger.error(
        {
          circuit: this.name,
          resetTimeoutMs: this.resetTimeoutMs,
          nextAttemptAt: new Date(this.nextAttempt).toISOString(),
        },
        'Circuit breaker TRIPPED to OPEN state',
      );
    }
  }

  /** Force reset for tests or administrative resets */
  public reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttempt = 0;
  }
}
