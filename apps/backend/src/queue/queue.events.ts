import { QueueEvents } from 'bullmq';
import { logger } from '../lib/logger.js';
import { getRedisConnection } from './connection.js';
import { EMAIL_QUEUE_NAME, type QueueScope } from './email.queue.js';

// Queue-wide observation of job state changes (from any worker/producer),
// read from BullMQ's Redis event stream. Logging only.
export function createEmailQueueEvents({ prefix }: QueueScope = {}) {
  const events = new QueueEvents(EMAIL_QUEUE_NAME, { connection: getRedisConnection(), prefix });
  const log = logger.child({ source: 'queue-events', queue: EMAIL_QUEUE_NAME });

  events.on('waiting', ({ jobId }) => log.info('job waiting', { jobId }));
  events.on('delayed', ({ jobId, delay }) => log.info('job delayed', { jobId, runAt: new Date(Number(delay)).toISOString() }));
  events.on('active', ({ jobId }) => log.info('job active', { jobId }));
  events.on('completed', ({ jobId }) => log.info('job completed', { jobId }));
  events.on('failed', ({ jobId, failedReason }) => log.warn('job failed', { jobId, failedReason }));
  events.on('error', (err) => log.error('queue events error', { err }));

  return events;
}
