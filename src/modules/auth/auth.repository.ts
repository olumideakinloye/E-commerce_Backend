import type { Types } from 'mongoose';
import { User, type UserDoc } from '@modules/auth/models/user.model.js';
import { RefreshToken } from '@modules/auth/models/refresh-token.model.js';

// ─── User Queries ──────────────────────────────────────────────────────────────

export async function findUserByEmail(email: string): Promise<UserDoc | null> {
  return User.findOne({ email: email.toLowerCase().trim() }).lean<UserDoc>();
}

export async function findUserById(userId: string | Types.ObjectId): Promise<UserDoc | null> {
  return User.findById(userId).lean<UserDoc>();
}

export async function createUser(data: {
  email: string;
  passwordHash: string;
  role?: 'customer' | 'admin';
}): Promise<UserDoc> {
  const user = await User.create({
    email: data.email.toLowerCase().trim(),
    passwordHash: data.passwordHash,
    role: data.role ?? 'customer',
    tokenVersion: 0,
  });
  return user.toObject() as UserDoc;
}

export async function incrementTokenVersion(userId: string | Types.ObjectId): Promise<void> {
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
}

/** True when Mongo rejected an insert because of a unique index (E11000). */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

// ─── Refresh Token Queries ─────────────────────────────────────────────────────

export async function createRefreshToken(data: {
  userId: Types.ObjectId;
  tokenHash: string;
  family: string;
  expiresAt: Date;
}): Promise<void> {
  await RefreshToken.create(data);
}

export async function findRefreshTokenByHash(tokenHash: string) {
  return RefreshToken.findOne({ tokenHash }).lean();
}

/**
 * ATOMIC single-use consume. Only ONE caller can flip revokedAt from null, so two
 * concurrent refreshes with the same token can never both succeed.
 * Returns the token document (pre-update) if this call won, otherwise null.
 */
export async function consumeRefreshToken(tokenHash: string) {
  const now = new Date();
  return RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { revokedAt: now } },
  ).lean();
}

export async function revokeRefreshToken(tokenHash: string): Promise<void> {
  await RefreshToken.updateOne({ tokenHash, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

/** Reuse-detection response: kill every token in the family. */
export async function revokeFamilyTokens(family: string): Promise<void> {
  await RefreshToken.updateMany({ family, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

/** Used by logout-all: every refresh token the user owns stops working. */
export async function revokeAllUserRefreshTokens(userId: string | Types.ObjectId): Promise<void> {
  await RefreshToken.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export async function deleteExpiredRefreshTokens(userId: Types.ObjectId): Promise<void> {
  await RefreshToken.deleteMany({ userId, expiresAt: { $lt: new Date() } });
}
