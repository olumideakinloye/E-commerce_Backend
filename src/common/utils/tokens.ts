import jwt, { type SignOptions } from 'jsonwebtoken';
import { randomBytes, createHash } from 'node:crypto';
import { env } from '@config/env.js';
import type { UserRole } from '@modules/auth/models/user.model.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AccessTokenPayload {
  sub: string; // userId
  role: UserRole;
  tokenVersion: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string; // opaque random, NOT the hash
}

// ─── Access Token ─────────────────────────────────────────────────────────────

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as SignOptions['expiresIn'],
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: ['HS256'],
  }) as AccessTokenPayload;
}

// ─── Refresh Token ────────────────────────────────────────────────────────────

/**
 * Generates a cryptographically secure opaque refresh token.
 * Returns the raw token (sent to client) and the hash (stored in DB).
 */
export function generateRefreshToken(): { raw: string; hash: string; family: string } {
  const raw = randomBytes(64).toString('hex');
  const hash = hashRefreshToken(raw);
  const family = randomBytes(16).toString('hex');
  return { raw, hash, family };
}

export function generateRefreshTokenWithFamily(_family: string): {
  raw: string;
  hash: string;
} {
  const raw = randomBytes(64).toString('hex');
  const hash = hashRefreshToken(raw);
  return { raw, hash };
}

export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function refreshTokenExpiresAt(): Date {
  const days = env.JWT_REFRESH_EXPIRES_IN_DAYS;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}
