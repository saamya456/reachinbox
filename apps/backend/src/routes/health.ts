import type { Client } from '@elastic/elasticsearch';
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { getRedisConnection } from '../queue/connection.js';
import { isElasticsearchUp } from '../search/elasticsearch.js';

const CHECK_TIMEOUT_MS = 2_000;

// The BullMQ connection retries forever while Redis is down, so bound the check.
function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS).unref()),
  ]);
}

async function isUp(check: () => Promise<unknown>): Promise<boolean> {
  try {
    await withTimeout(check());
    return true;
  } catch {
    return false;
  }
}

// PostgreSQL and Redis are required (503 when down). Elasticsearch only powers
// search, so its outage reports "degraded" with 200: scheduling and sending
// keep working without it.
export function createHealthRouter(getSearchClient: () => Client) {
  const router = Router();
  router.get('/', async (_req, res) => {
    const [database, redis, elasticsearch] = await Promise.all([
      isUp(() => prisma.$queryRaw`SELECT 1`),
      isUp(() => getRedisConnection().ping()),
      isElasticsearchUp(getSearchClient()),
    ]);
    const core = database && redis;
    res.status(core ? 200 : 503).json({
      status: core && elasticsearch ? 'ok' : 'degraded',
      database: database ? 'up' : 'down',
      redis: redis ? 'up' : 'down',
      elasticsearch: elasticsearch ? 'up' : 'down',
    });
  });
  return router;
}
