import pino from 'pino';
import { env } from '@config/env.js';

const isDev = env.NODE_ENV === 'development';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'headers.authorization',
      'headers.cookie',
      'headers["x-api-key"]',
      'password',
      'passwordHash',
      'token',
      'refreshToken',
      'accessToken',
      'secret',
      'creditCard',
      'cardNumber',
      'cvv',
      'payload.password',
      'body.password',
      'body.token',
      'body.refreshToken',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});
