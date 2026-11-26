import { z } from 'zod';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    POSTGRES_URL: z.url({
      protocol: /^postgres(ql)?$/,
      error: 'POSTGRES_URL must be a valid postgres:// or postgresql:// connection URL',
    }),
    REDIS_URL: z.url({
      protocol: /^rediss?$/,
      error: 'REDIS_URL must be a valid redis:// or rediss:// connection URL',
    }),
    APP_SECRET: z.string().min(32, {
      error: 'APP_SECRET must be at least 32 characters long',
    }),
    ENCRYPTION_MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, {
      error: 'ENCRYPTION_MASTER_KEY must be an exact 64-character hexadecimal string (32 bytes)',
    }),
    JWT_ACCESS_SECRET: z.string().min(32, {
      error: 'JWT_ACCESS_SECRET must be at least 32 characters long',
    }),
    JWT_REFRESH_SECRET: z.string().min(32, {
      error: 'JWT_REFRESH_SECRET must be at least 32 characters long',
    }),
    JWT_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
    JWT_REFRESH_TTL_SEC: z.coerce.number().int().positive().default(604800),
  })
  .refine((env) => env.JWT_ACCESS_SECRET !== env.JWT_REFRESH_SECRET, {
    path: ['JWT_REFRESH_SECRET'],
    message: 'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be distinct secrets',
  });

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    const formatted = z.prettifyError(parsed.error);
    throw new Error(`Invalid environment configuration:\n${formatted}`);
  }

  return parsed.data;
}
