import { config } from 'dotenv';
import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

// Share the root .env with docker-compose; an app-level .env may override it.
config({ path: resolve(import.meta.dirname, '../../.env') });
config();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Fallback keeps `prisma generate` (postinstall) working before .env exists.
    url:
      process.env.DATABASE_URL ??
      'postgresql://reachinbox:reachinbox@localhost:5432/reachinbox?schema=public',
  },
});
