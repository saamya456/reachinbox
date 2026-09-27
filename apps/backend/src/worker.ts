// Worker process entry point: one startup reconciliation pass, then the BullMQ
// email worker, the Slack notification worker, the search indexing worker and
// its outbox relay, plus queue event logging. Separate from the API process
// (src/index.ts) so they scale independently.
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { closeRedisConnection } from './queue/connection.js';
import { closeEmailQueue, EMAIL_QUEUE_NAME } from './queue/email.queue.js';
import { createEmailQueueEvents } from './queue/queue.events.js';
import { startEmailWorker } from './queue/start-worker.js';
import { closeElasticsearchClient } from './search/elasticsearch.js';
import { startOutboxRelay, type OutboxRelay } from './search/outbox-relay.js';
import { closeSearchIndexQueue, createSearchIndexWorker } from './search/search-index.queue.js';
import { slackConfigFromEnv } from './slack/slack-api.js';
import {
  closeSlackQueue,
  createSlackNotificationWorker,
  subscribeHourlyLimitNotifications,
} from './slack/slack-notifications.js';

logger.info('worker process starting', {
  queue: EMAIL_QUEUE_NAME,
  concurrency: env.WORKER_CONCURRENCY,
  pid: process.pid,
});

// hourlyLimitReached (emitted by email processing) -> slack-notifications queue.
const unsubscribeSlack = subscribeHourlyLimitNotifications();
const slackWorker = createSlackNotificationWorker({ webhookHosts: slackConfigFromEnv()?.webhookHosts });

// search_outbox -> search-index queue -> Elasticsearch. Independent of email
// sending: if Elasticsearch is down, index jobs retry while emails still go out.
const searchWorker = createSearchIndexWorker();
let relay: OutboxRelay | undefined;
try {
  relay = await startOutboxRelay();
} catch (err) {
  // PostgreSQL is required anyway; log and continue so email sending is unaffected.
  logger.error('search outbox relay failed to start; index updates wait in the outbox', { err });
}

const queueEvents = createEmailQueueEvents();
const { worker } = await startEmailWorker();

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('worker process shutting down', { signal });
  // close() waits for active jobs to finish; delayed/waiting jobs stay in Redis.
  await worker.close();
  unsubscribeSlack();
  await slackWorker.close();
  await relay?.stop();
  await searchWorker.close();
  await queueEvents.close();
  await closeEmailQueue();
  await closeSlackQueue();
  await closeSearchIndexQueue();
  await closeRedisConnection();
  await closeElasticsearchClient();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
