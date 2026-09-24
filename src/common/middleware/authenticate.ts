import type { FastifyRequest, FastifyReply } from 'fastify';
import { ForbiddenError, UnauthorizedError } from '@common/errors.js';
import { verifyAccessToken } from '@common/utils/tokens.js';
import { findUserById } from '@modules/auth/auth.repository.js';
import type { UserRole } from '@modules/auth/models/user.model.js';

// ─── Augment Fastify request with authenticated user ─────────────────────────
declare module 'fastify' {
  interface FastifyRequest {
    user: {
      id: string;
      role: UserRole;
      tokenVersion: number;
    };
  }
}

// ─── authenticate middleware ──────────────────────────────────────────────────

/**
 * Verifies the Bearer access token and attaches the decoded payload to req.user.
 * Also validates tokenVersion against the DB to support global logout.
 *
 * Usage: preHandler hook on protected routes.
 */
export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or malformed Authorization header');
  }

  const token = authHeader.slice(7);

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw new UnauthorizedError('Invalid or expired access token');
  }

  // Verify tokenVersion to support global logout (invalidates all outstanding tokens)
  const user = await findUserById(payload.sub);

  if (!user) {
    throw new UnauthorizedError('User no longer exists');
  }

  if (user.tokenVersion !== payload.tokenVersion) {
    throw new UnauthorizedError('Token has been revoked — please log in again');
  }

  request.user = {
    id: payload.sub,
    role: payload.role,
    tokenVersion: payload.tokenVersion,
  };
}

// ─── authorize guard ──────────────────────────────────────────────────────────

/**
 * Role-based access guard. Must be used after `authenticate`.
 *
 * This is RBAC, not ownership: a customer hitting an admin-only route gets a
 * plain 403. The route's existence isn't a secret (it's in the API docs), so
 * there's nothing to hide by pretending it's a 404.
 *
 * Per-resource *ownership* checks (e.g. "is this order yours?") are a
 * different concern with a different status code — see common/ownership.ts,
 * which returns 404 there because existence itself is what must stay hidden.
 *
 * @example
 *   preHandler: [authenticate, authorize('admin')]
 */
export function authorize(...allowedRoles: UserRole[]) {
  return async function (request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.user) {
      throw new UnauthorizedError('Not authenticated');
    }

    if (!allowedRoles.includes(request.user.role)) {
      throw new ForbiddenError('Insufficient permissions');
    }
  };
}
