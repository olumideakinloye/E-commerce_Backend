import { z } from 'zod';

// Normalise first (trim + lowercase), then validate, so " Bob@X.com " == "bob@x.com".
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('Must be a valid email address'));

// 72 is a bcrypt limit, not an argon2 one. A generous cap just bounds hashing cost.
const newPassword = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must not exceed 128 characters');

// strictObject rejects unknown keys (blocks mass-assignment like { role: 'admin' }).
export const RegisterBodySchema = z.strictObject({ email, password: newPassword });

export const LoginBodySchema = z.strictObject({
  email,
  password: z.string().min(1, 'Password is required').max(128),
});

export const RefreshBodySchema = z.strictObject({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const LogoutBodySchema = z.strictObject({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export type RegisterBody = z.infer<typeof RegisterBodySchema>;
export type LoginBody = z.infer<typeof LoginBodySchema>;
export type RefreshBody = z.infer<typeof RefreshBodySchema>;
export type LogoutBody = z.infer<typeof LogoutBodySchema>;
