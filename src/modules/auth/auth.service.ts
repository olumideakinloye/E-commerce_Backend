import type { Types } from 'mongoose';
import { ConflictError, UnauthorizedError, ForbiddenError } from '@common/errors.js';
import { hashPassword, verifyPassword, verifyAgainstDummy } from '@common/utils/password.js';
import {
  signAccessToken,
  generateRefreshToken,
  generateRefreshTokenWithFamily,
  hashRefreshToken,
  refreshTokenExpiresAt,
  type TokenPair,
} from '@common/utils/tokens.js';
import {
  findUserByEmail,
  findUserById,
  createUser,
  isDuplicateKeyError,
  incrementTokenVersion,
  createRefreshToken,
  findRefreshTokenByHash,
  consumeRefreshToken,
  revokeRefreshToken,
  revokeFamilyTokens,
  revokeAllUserRefreshTokens,
} from './auth.repository.js';

// ─── Register ─────────────────────────────────────────────────────────────────

export async function register(data: {
  email: string;
  password: string;
}): Promise<{ userId: string }> {
  // Hash first, always: existing and new emails then cost the same time.
  const passwordHash = await hashPassword(data.password);

  try {
    const user = await createUser({ email: data.email, passwordHash });
    return { userId: (user._id as Types.ObjectId).toString() };
  } catch (err) {
    // The unique index is the real guard (race-safe); no "find then insert".
    // NOTE: this reveals that the email is registered. Fully hiding that needs
    // email verification ("check your inbox"), which is a roadmap item.
    if (isDuplicateKeyError(err)) {
      throw new ConflictError('An account with this email already exists');
    }
    throw err;
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────

export async function login(data: { email: string; password: string }): Promise<TokenPair> {
  const user = await findUserByEmail(data.email);

  let passwordMatch = false;
  if (user) {
    passwordMatch = await verifyPassword(user.passwordHash, data.password);
  } else {
    await verifyAgainstDummy(data.password);
  }

  if (!user || !passwordMatch) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const { raw, hash, family } = generateRefreshToken();

  await createRefreshToken({
    userId: user._id as Types.ObjectId,
    tokenHash: hash,
    family,
    expiresAt: refreshTokenExpiresAt(),
  });

  const accessToken = signAccessToken({
    sub: (user._id as Types.ObjectId).toString(),
    role: user.role,
    tokenVersion: user.tokenVersion,
  });

  return { accessToken, refreshToken: raw };
}

// ─── Refresh Tokens ───────────────────────────────────────────────────────────

export async function refresh(rawRefreshToken: string): Promise<TokenPair> {
  const tokenHash = hashRefreshToken(rawRefreshToken);

  // Atomic: exactly one concurrent caller gets the token back.
  const consumed = await consumeRefreshToken(tokenHash);

  if (!consumed) {
    // Lost the race, expired, revoked, or never existed. Work out which.
    const existing = await findRefreshTokenByHash(tokenHash);
    if (existing?.revokedAt) {
      // A used/revoked token came back => possible theft. Kill the whole family.
      await revokeFamilyTokens(existing.family);
      throw new ForbiddenError(
        'Refresh token reuse detected. All sessions have been revoked for security.',
      );
    }
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  const user = await findUserById(consumed.userId as Types.ObjectId);
  if (!user) {
    throw new UnauthorizedError('User no longer exists');
  }

  const { raw: newRaw, hash: newHash } = generateRefreshTokenWithFamily(consumed.family);

  await createRefreshToken({
    userId: consumed.userId as Types.ObjectId,
    tokenHash: newHash,
    family: consumed.family,
    expiresAt: refreshTokenExpiresAt(),
  });

  const accessToken = signAccessToken({
    sub: (user._id as Types.ObjectId).toString(),
    role: user.role,
    tokenVersion: user.tokenVersion,
  });

  return { accessToken, refreshToken: newRaw };
}

// ─── Logout ───────────────────────────────────────────────────────────────────

export async function logout(rawRefreshToken: string): Promise<void> {
  await revokeRefreshToken(hashRefreshToken(rawRefreshToken));
}

// ─── Logout All Sessions ──────────────────────────────────────────────────────

export async function logoutAll(userId: string): Promise<void> {
  // 1) invalidate every outstanding ACCESS token
  await incrementTokenVersion(userId);
  // 2) invalidate every REFRESH token, otherwise they'd just mint fresh access tokens
  await revokeAllUserRefreshTokens(userId);
}
