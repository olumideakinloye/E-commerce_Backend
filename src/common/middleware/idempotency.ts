/**
 * Reusable Idempotency Middleware for Fastify
 *
 * Implements IETF draft-ietf-httpapi-idempotency-key-header standards.
 * Guarantees that duplicate requests with the same Idempotency-Key:
 *   1. Return the cached original response if the request body is identical (HTTP 200/201).
 *   2. Reject with HTTP 422 if the key is reused with a different request body.
 *   3. Reject with HTTP 409 if a concurrent identical request is still processing.
 *
 * Scoped by authenticated userId + idempotency key.
 */

import crypto from 'node:crypto';
import { Types } from 'mongoose';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { IdempotencyKey } from '@common/models/idempotency-key.model.js';
import {
  BadRequestError,
  UnprocessableEntityError,
  UnauthorizedError,
  ConflictError,
} from '@common/errors.js';
import { logger } from '@common/logger.js';

export interface IdempotencyContext {
  key: string;
  userId: string;
  requestHash: string;
  ttlHours: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyContext?: IdempotencyContext;
  }
}

export interface IdempotencyOptions {
  ttlHours?: number;
  required?: boolean;
}

export function idempotency(options: IdempotencyOptions = {}) {
  const ttlHours = options.ttlHours ?? 24;
  const isRequired = options.required ?? true;

  return async function idempotencyPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const rawKey = request.headers['idempotency-key'] || request.headers['x-idempotency-key'];

    if (!rawKey || typeof rawKey !== 'string' || !rawKey.trim()) {
      if (isRequired) {
        throw new BadRequestError('Idempotency-Key header is required for this operation');
      }
      return;
    }

    const key = rawKey.trim();

    if (!request.user?.id) {
      throw new UnauthorizedError('Authentication required for idempotent operations');
    }

    const userId = request.user.id;
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(request.body ?? {}))
      .digest('hex');

    const existing = await IdempotencyKey.findOne({
      userId: new Types.ObjectId(userId),
      key,
    });

    if (existing) {
      // Scenario C: Same key, different body -> 422
      if (existing.requestHash !== requestHash) {
        throw new UnprocessableEntityError(
          'Idempotency key has already been used with a different request payload',
        );
      }

      // Replay stored response if already completed
      if (existing.response) {
        logger.info(
          { key, userId, statusCode: existing.response.statusCode },
          'Replaying cached idempotent response',
        );
        reply.header('x-cache-lookup', 'HIT-IDEMPOTENT');
        return reply.status(existing.response.statusCode).send(existing.response.body);
      }

      // If response is null, another identical request is currently in-flight
      throw new ConflictError('A request with this idempotency key is currently being processed');
    }

    // Attach context so onSend hook can persist the response
    request.idempotencyContext = {
      key,
      userId,
      requestHash,
      ttlHours,
    };
  };
}

/**
 * Fastify onSend hook to automatically cache successful idempotent responses.
 */
export async function saveIdempotentResponseHook(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  const ctx = request.idempotencyContext;
  if (!ctx) return payload;

  // Only cache 2xx responses
  if (reply.statusCode >= 200 && reply.statusCode < 300) {
    try {
      let parsedBody = payload;
      if (typeof payload === 'string') {
        try {
          parsedBody = JSON.parse(payload);
        } catch {
          parsedBody = payload;
        }
      }

      const expiresAt = new Date(Date.now() + ctx.ttlHours * 60 * 60 * 1000);

      await IdempotencyKey.findOneAndUpdate(
        {
          userId: new Types.ObjectId(ctx.userId),
          key: ctx.key,
        },
        {
          $setOnInsert: {
            userId: new Types.ObjectId(ctx.userId),
            key: ctx.key,
            requestHash: ctx.requestHash,
            expiresAt,
            response: {
              statusCode: reply.statusCode,
              headers: {},
              body: parsedBody,
            },
          },
        },
        { upsert: true },
      );

      logger.debug({ key: ctx.key, userId: ctx.userId }, 'Cached idempotent response');
    } catch (err) {
      logger.error({ err, key: ctx.key }, 'Failed to cache idempotent response');
    }
  }

  return payload;
}
