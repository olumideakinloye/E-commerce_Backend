import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '@common/utils/password.js';
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  generateRefreshTokenWithFamily,
  hashRefreshToken,
} from '@common/utils/tokens.js';

describe('Auth Utilities', () => {
  describe('Password hashing (argon2id)', () => {
    it('hashes a password and verifies it correctly', async () => {
      const password = 'SuperSecure!Password123';
      const hash = await hashPassword(password);

      expect(hash).not.toBe(password);
      expect(hash).toContain('$argon2id$');

      const valid = await verifyPassword(hash, password);
      expect(valid).toBe(true);
    });

    it('returns false for wrong password', async () => {
      const hash = await hashPassword('correct-password');
      const valid = await verifyPassword(hash, 'wrong-password');
      expect(valid).toBe(false);
    });

    it('produces different hashes for same password (salt randomisation)', async () => {
      const password = 'same-password';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('Access Token (JWT)', () => {
    it('signs and verifies access token with correct payload', () => {
      const payload = { sub: 'user123', role: 'customer' as const, tokenVersion: 0 };
      const token = signAccessToken(payload);

      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);

      const decoded = verifyAccessToken(token);
      expect(decoded.sub).toBe('user123');
      expect(decoded.role).toBe('customer');
      expect(decoded.tokenVersion).toBe(0);
    });

    it('throws on tampered token', () => {
      const payload = { sub: 'user123', role: 'customer' as const, tokenVersion: 0 };
      const token = signAccessToken(payload);
      const tampered = token.slice(0, -4) + 'XXXX';

      expect(() => verifyAccessToken(tampered)).toThrow();
    });
  });

  describe('Refresh Token', () => {
    it('generates a cryptographically random token with a family', () => {
      const { raw, hash, family } = generateRefreshToken();

      expect(typeof raw).toBe('string');
      expect(raw.length).toBeGreaterThanOrEqual(128); // 64 bytes as hex
      expect(typeof family).toBe('string');
      expect(family.length).toBeGreaterThanOrEqual(32);

      // Hash must differ from raw
      expect(hash).not.toBe(raw);
    });

    it('produces same hash for same raw token (deterministic)', () => {
      const { raw } = generateRefreshToken();
      const hash1 = hashRefreshToken(raw);
      const hash2 = hashRefreshToken(raw);
      expect(hash1).toBe(hash2);
    });

    it('generates different tokens for same family', () => {
      const { raw: raw1 } = generateRefreshToken();
      const family = 'test-family';
      const { raw: raw2 } = generateRefreshTokenWithFamily(family);
      expect(raw1).not.toBe(raw2);
    });
  });
});
