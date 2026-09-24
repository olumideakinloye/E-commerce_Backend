import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env file into process.env
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  // Database & Cache
  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  REDIS_URL: z.string().url('REDIS_URL must be a valid url').default('redis://localhost:6379'),

  // Authentication & Secrets
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_REFRESH_EXPIRES_IN_DAYS: z.coerce.number().int().positive().default(7),

  // Payment Providers
  PAYSTACK_SECRET_KEY: z.string().default('sk_test_placeholder'),
  STRIPE_SECRET_KEY: z.string().default('sk_test_placeholder'),
  PAYMENT_WEBHOOK_SECRET: z.string().default('webhook_secret_placeholder'),

  // Inventory & Orders
  RESERVATION_TTL_MINUTES: z.coerce.number().int().positive().default(15),

  // Rate Limiting
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_GLOBAL_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_CHECKOUT_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_CHECKOUT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // Logging & Tracing
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formattedErrors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    console.error('CRITICAL: Environment variable validation failed:\n' + formattedErrors);
    console.error('Please verify your .env file matches .env.example.');
    process.exit(1);
  }

  return result.data;
}

export const env = parseEnv();
