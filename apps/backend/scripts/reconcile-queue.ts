// Manual repair: the same reconciliation pass the worker runs once at startup.
// Resolves orphaned PROCESSING claims and ensures every SCHEDULED email has its
// BullMQ job. Idempotent thanks to deterministic job ids and token-conditional
// writes. Run: npm run queue:reconcile -w apps/backend
import { logger } from '../src/lib/logger.js';
import { prisma } from '../src/lib/prisma.js';
import { closeRedisConnection } from '../src/queue/connection.js';
import { closeEmailQueue } from '../src/queue/email.queue.js';
import { reconcileEmailJobs } from '../src/services/email-scheduler.service.js';

try {
  const result = await reconcileEmailJobs();
  logger.info('queue reconciliation finished', { ...result });
} finally {
  await closeEmailQueue();
  await closeRedisConnection();
  await prisma.$disconnect();
}
