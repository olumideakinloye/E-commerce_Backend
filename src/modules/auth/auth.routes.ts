import type { FastifyInstance } from 'fastify';
import { authenticate } from '@common/middleware/authenticate.js';
import {
  handleRegister,
  handleLogin,
  handleRefresh,
  handleLogout,
  handleLogoutAll,
} from './auth.controller.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // POST /auth/register
  app.post('/register', handleRegister);

  // POST /auth/login
  app.post('/login', handleLogin);

  // POST /auth/refresh
  app.post('/refresh', handleRefresh);

  // POST /auth/logout (requires valid refresh token in body)
  app.post('/logout', handleLogout);

  // POST /auth/logout-all (requires authenticated access token)
  app.post(
    '/logout-all',
    {
      preHandler: [authenticate],
    },
    handleLogoutAll,
  );
}
