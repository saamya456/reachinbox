import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

// The single Redis client for BullMQ in this process. Queue, Worker and
// QueueEvents (and a later bull-board integration) all receive this instance.
// BullMQ duplicates it internally for blocking commands (Worker, QueueEvents)
// and owns those duplicates; this module owns and closes the shared client.
//
// An instance (rather than connection options) is required because BullMQ 6
// can only construct its own ioredis client via `require`, which is unavailable
// in this ESM package.
//
// maxRetriesPerRequest: null is required by BullMQ for workers: commands wait
// for Redis to come back instead of failing after N reconnect attempts.

let client: Redis | undefined;

export function getRedisConnection(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      connectionName: 'reachinbox',
    });
    client.on('error', (err) => logger.error('redis connection error', { err }));
  }
  return client;
}

export async function closeRedisConnection(): Promise<void> {
  if (!client) return;
  const current = client;
  client = undefined;
  await current.quit();
}
