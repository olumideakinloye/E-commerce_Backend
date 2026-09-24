import type { FastifyRequest, FastifyReply } from 'fastify';
import { UnauthorizedError } from '@common/errors.js';
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
 * @example
 *   preHandler: [authenticate, authorize('admin')]
 */
export function authorize(...allowedRoles: UserRole[]) {
  return async function (request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.user) {
      throw new UnauthorizedError('Not authenticated');
    }

    if (!allowedRoles.includes(request.user.role)) {
      // Return 404 instead of 403 to avoid leaking resource existence to other users
      // For admin-only routes we use 403 since the route itself is known
      throw new UnauthorizedError('Insufficient permissions');
    }
  };
}
