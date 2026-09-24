import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, type ErrorEnvelope } from './errors.js';
import { env } from '@config/env.js';

export function errorHandler(
  error: FastifyError | AppError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = request.id;

  // Handle known application errors
  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      request.log.error({ err: error, requestId }, error.message);
    } else {
      request.log.warn({ err: error, requestId }, error.message);
    }

    const envelope: ErrorEnvelope = {
      error: {
        code: error.code,
        message: error.message,
        requestId,
        details: error.details,
      },
    };

    reply.status(error.statusCode).send(envelope);
    return;
  }

  // Handle Zod validation errors
  if (error instanceof ZodError) {
    request.log.warn({ issues: error.issues, requestId }, 'Validation Error');

    const envelope: ErrorEnvelope = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        requestId,
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };

    reply.status(400).send(envelope);
    return;
  }

  // Handle Fastify built-in schema / bad-request errors
  if ('statusCode' in error && typeof error.statusCode === 'number') {
    request.log.warn({ err: error, requestId }, error.message);

    const envelope: ErrorEnvelope = {
      error: {
        code: error.code ?? 'BAD_REQUEST',
        message: error.message,
        requestId,
      },
    };

    reply.status(error.statusCode).send(envelope);
    return;
  }

  // Unhandled / 500 errors
  request.log.error({ err: error, requestId }, 'Unhandled Exception');

  const envelope: ErrorEnvelope = {
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: env.NODE_ENV === 'production' ? 'An unexpected error occurred' : error.message,
      requestId,
    },
  };

  reply.status(500).send(envelope);
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  const requestId = request.id;
  const envelope: ErrorEnvelope = {
    error: {
      code: 'NOT_FOUND',
      message: `Route ${request.method} ${request.url} not found`,
      requestId,
    },
  };

  reply.status(404).send(envelope);
}
