import type { FastifyRequest, FastifyReply } from 'fastify';
import { BadRequestError } from '@common/errors.js';
import { register, login, refresh, logout, logoutAll } from './auth.service.js';
import {
  RegisterBodySchema,
  LoginBodySchema,
  RefreshBodySchema,
  LogoutBodySchema,
} from './auth.schemas.js';

// ─── POST /auth/register ──────────────────────────────────────────────────────

export async function handleRegister(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = RegisterBodySchema.safeParse(request.body);
  if (!result.success) {
    throw new BadRequestError('Validation failed', result.error.issues);
  }

  const { userId } = await register(result.data);

  reply.status(201).send({
    message: 'Account created successfully',
    userId,
  });
}

// ─── POST /auth/login ─────────────────────────────────────────────────────────

export async function handleLogin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = LoginBodySchema.safeParse(request.body);
  if (!result.success) {
    throw new BadRequestError('Validation failed', result.error.issues);
  }

  const tokens = await login(result.data);

  reply.status(200).send(tokens);
}

// ─── POST /auth/refresh ───────────────────────────────────────────────────────

export async function handleRefresh(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = RefreshBodySchema.safeParse(request.body);
  if (!result.success) {
    throw new BadRequestError('Validation failed', result.error.issues);
  }

  const tokens = await refresh(result.data.refreshToken);

  reply.status(200).send(tokens);
}

// ─── POST /auth/logout ────────────────────────────────────────────────────────

export async function handleLogout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = LogoutBodySchema.safeParse(request.body);
  if (!result.success) {
    throw new BadRequestError('Validation failed', result.error.issues);
  }

  await logout(result.data.refreshToken);

  reply.status(204).send();
}

// ─── POST /auth/logout-all ────────────────────────────────────────────────────

export async function handleLogoutAll(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await logoutAll(request.user.id);
  reply.status(204).send();
}
