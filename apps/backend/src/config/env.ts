import { config } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

// Load the root .env first (shared with docker-compose), then an optional app-level .env.
// Path is relative to src/config (and dist/config after build).
config({ path: resolve(import.meta.dirname, '../../../../.env'), quiet: true });
config({ quiet: true });

// An unset or empty variable both mean 'not configured'.
const optionalString = z
  .string()
  .trim()
  .min(1)
  .optional()
  .or(z.literal('').transform(() => undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  MIN_SEND_DELAY_MS: z.coerce.number().int().min(0).max(3_600_000).default(2_000),
  // Optional global cap per sender and hour, applied on top of each sender's own hourly_limit.
  MAX_EMAILS_PER_HOUR_PER_SENDER: z
    .union([z.literal('').transform(() => undefined), z.coerce.number().int().min(1).max(100_000)])
    .optional(),
  ELASTICSEARCH_URL: z.string().url().default('http://localhost:9200'),
  // Alias of the email search index (the physical index is <alias>-v1).
  ELASTICSEARCH_EMAIL_INDEX: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).default('reachinbox-emails'),
  // Optional Elasticsearch credentials (the local dev container runs without security).
  ELASTICSEARCH_USERNAME: optionalString,
  ELASTICSEARCH_PASSWORD: optionalString,
  ELASTICSEARCH_API_KEY: optionalString,
  // Comma-separated emails allowed to open the BullMQ dashboard (/admin/queues).
  ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)),
  // Frontend origin: post-login redirects and the allowed Origin for state-changing requests.
  APP_URL: z.string().url().default('http://localhost:5173'),
  // Google OAuth (OpenID Connect). Optional: without them /auth/google answers 503.
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_CALLBACK_URL: z.string().url().default('http://localhost:4000/auth/google/callback'),
  // Slack OAuth v2. Optional: without them /slack/connect answers 503.
  SLACK_CLIENT_ID: optionalString,
  SLACK_CLIENT_SECRET: optionalString,
  SLACK_REDIRECT_URI: z.string().url().default('http://localhost:4000/slack/callback'),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be a base64-encoded 32-byte key'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
