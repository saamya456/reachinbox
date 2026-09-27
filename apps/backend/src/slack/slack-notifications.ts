import { Queue, UnrecoverableError, Worker, type DefaultJobOptions } from 'bullmq';
import { z } from 'zod';
import { emailEvents, type HourlyLimitReachedEvent } from '../events/email-events.js';
import { decryptSecret } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getRedisConnection } from '../queue/connection.js';
import type { QueueScope } from '../queue/email.queue.js';
import { isAllowedWebhookUrl, postToWebhook, SLACK_ENDPOINTS } from './slack-api.js';

// Slack notification when an hourly limit is reached.
//
// The Phase 4 event fires at most once per sender (or campaign) and window
// across all processes. Its listener only enqueues a job on a separate BullMQ
// queue; a dedicated worker posts the message. Email processing therefore
// never waits for, or fails because of, Slack:
//  - enqueue errors are caught and logged;
//  - Slack errors only affect the notification job (retried with backoff when
//    transient, dropped when Slack says the connection is gone).
// Deterministic job ids (one per user/scope/window) make duplicate events a
// no-op. Job data holds ids only, never a token or webhook URL.

export const SLACK_QUEUE_NAME = 'slack-notifications';
const JOB_NAME = 'hourly-limit-reached';

export const slackJobSchema = z.strictObject({
  userId: z.uuid(),
  senderId: z.uuid(),
  campaignId: z.uuid(),
  scope: z.enum(['sender', 'campaign', 'spacing']),
  windowStart: z.iso.datetime(),
  nextSlotAt: z.iso.datetime(),
});

export type SlackJobData = z.infer<typeof slackJobSchema>;

export type SlackNotificationResult =
  | { outcome: 'sent' }
  | { outcome: 'skipped'; reason: 'no_active_connection' }
  | { outcome: 'connection_disabled'; status: 'REVOKED' | 'ERROR'; reason: string };

const JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

export function createSlackQueue({ prefix }: QueueScope = {}) {
  return new Queue<SlackJobData, SlackNotificationResult>(SLACK_QUEUE_NAME, {
    connection: getRedisConnection(),
    prefix,
    defaultJobOptions: JOB_OPTIONS,
  });
}

export type SlackQueue = ReturnType<typeof createSlackQueue>;

let slackQueue: SlackQueue | undefined;
export function getSlackQueue(): SlackQueue {
  slackQueue ??= createSlackQueue();
  return slackQueue;
}
export async function closeSlackQueue() {
  const current = slackQueue;
  slackQueue = undefined;
  await current?.close();
}

export function slackJobId(data: SlackJobData): string {
  const scopeId = data.scope === 'campaign' ? data.campaignId : data.senderId;
  return `hourly-limit-${data.userId}-${data.scope}-${scopeId}-${new Date(data.windowStart).getTime()}`;
}

export async function enqueueHourlyLimitNotification(queue: SlackQueue, event: HourlyLimitReachedEvent) {
  const data: SlackJobData = {
    userId: event.userId,
    senderId: event.senderId,
    campaignId: event.campaignId,
    scope: event.scope,
    windowStart: event.windowStart.toISOString(),
    nextSlotAt: event.nextSlotAt.toISOString(),
  };
  await queue.add(JOB_NAME, data, { jobId: slackJobId(data) });
}

// Wires the Phase 4 event to the queue. Returns an unsubscribe function.
export function subscribeHourlyLimitNotifications(queue: SlackQueue = getSlackQueue()): () => void {
  const listener = (event: HourlyLimitReachedEvent) => {
    enqueueHourlyLimitNotification(queue, event).catch((err) =>
      logger.error('failed to enqueue slack notification', { err, userId: event.userId, senderId: event.senderId }),
    );
  };
  emailEvents.on('hourlyLimitReached', listener);
  return () => emailEvents.off('hourlyLimitReached', listener);
}

const escapeMrkdwn = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const utc = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

async function buildMessage(data: SlackJobData) {
  const [sender, campaign] = await Promise.all([
    prisma.sender.findFirst({ where: { id: data.senderId, userId: data.userId }, select: { email: true, hourlyLimit: true } }),
    prisma.campaign.findFirst({ where: { id: data.campaignId, userId: data.userId }, select: { subject: true, hourlyLimit: true } }),
  ]);
  const windowStart = new Date(data.windowStart);
  const nextSlotAt = new Date(data.nextSlotAt);
  const windowEnd = new Date(windowStart.getTime() + 60 * 60 * 1000);
  // Emails already pushed past this window (they wait for a later one).
  const waiting = await prisma.email.count({
    where: {
      userId: data.userId,
      status: 'SCHEDULED',
      scheduledAt: { gte: windowEnd },
      ...(data.scope === 'campaign' ? { campaignId: data.campaignId } : { senderId: data.senderId }),
    },
  });

  const senderLine = sender ? `${escapeMrkdwn(sender.email)} (limit ${sender.hourlyLimit}/hour)` : 'unknown sender';
  const campaignLine = campaign ? `"${escapeMrkdwn(campaign.subject)}" (limit ${campaign.hourlyLimit}/hour)` : 'unknown campaign';
  const reason =
    data.scope === 'campaign'
      ? 'The campaign reached its hourly limit.'
      : data.scope === 'sender'
        ? 'The sender reached its hourly limit.'
        : 'No more sends fit in this hour at the configured minimum delay.';

  const lines = [
    `*Hourly sending limit reached*`,
    reason,
    `*Sender:* ${senderLine}`,
    `*Campaign:* ${campaignLine}`,
    `*Window:* ${utc(windowStart)} – ${utc(windowEnd)}`,
    `*Next sending slot:* ${utc(nextSlotAt)}`,
    `*Emails moved to a later window so far:* ${waiting}`,
    'Remaining emails are rescheduled automatically; none are dropped.',
  ];
  return {
    text: `Hourly sending limit reached. Next sending slot: ${utc(nextSlotAt)}.`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }],
  };
}

export interface SlackWorkerOptions extends QueueScope {
  concurrency?: number;
  webhookHosts?: string[];
}

export async function processSlackNotification(
  data: SlackJobData,
  { webhookHosts = SLACK_ENDPOINTS.webhookHosts }: Pick<SlackWorkerOptions, 'webhookHosts'> = {},
): Promise<SlackNotificationResult> {
  const log = logger.child({ userId: data.userId, senderId: data.senderId, campaignId: data.campaignId });

  // Only ACTIVE connections are used: a revoked/errored or disconnected one is
  // never tried again with its old credentials.
  const connection = await prisma.slackConnection.findFirst({
    where: { userId: data.userId, status: 'ACTIVE' },
    select: { id: true, webhookUrlEncrypted: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!connection) {
    log.info('slack notification skipped: no active connection');
    return { outcome: 'skipped', reason: 'no_active_connection' };
  }

  const disable = async (status: 'REVOKED' | 'ERROR', reason: string): Promise<SlackNotificationResult> => {
    await prisma.slackConnection.updateMany({
      where: { id: connection.id, status: 'ACTIVE' },
      data: { status, lastError: reason.slice(0, 200) },
    });
    log.warn('slack connection disabled', { connectionId: connection.id, status, reason });
    return { outcome: 'connection_disabled', status, reason };
  };

  let webhookUrl: string;
  try {
    webhookUrl = decryptSecret(connection.webhookUrlEncrypted ?? '');
  } catch {
    return disable('ERROR', 'credentials_unreadable');
  }
  if (!isAllowedWebhookUrl({ webhookHosts }, webhookUrl)) return disable('ERROR', 'webhook_url_not_allowed');

  const result = await postToWebhook(webhookUrl, await buildMessage(data));
  switch (result.kind) {
    case 'ok':
      await prisma.slackConnection.update({ where: { id: connection.id }, data: { lastNotifiedAt: new Date(), lastError: null } });
      log.info('slack notification sent', { connectionId: connection.id, scope: data.scope });
      return { outcome: 'sent' };
    case 'revoked':
      return disable('REVOKED', result.reason);
    case 'rejected':
      return disable('ERROR', result.reason);
    case 'retry':
      // Transient (network, 5xx, 429): BullMQ retries with backoff.
      throw new Error(`Slack webhook temporarily unavailable: ${result.reason}`);
  }
}

export function createSlackNotificationWorker({ prefix, concurrency = 2, webhookHosts }: SlackWorkerOptions = {}) {
  const worker = new Worker<SlackJobData, SlackNotificationResult>(
    SLACK_QUEUE_NAME,
    async (job) => {
      const parsed = slackJobSchema.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError('Invalid slack notification job data');
      return processSlackNotification(parsed.data, { webhookHosts });
    },
    { connection: getRedisConnection(), prefix, concurrency },
  );
  worker.on('failed', (job, err) =>
    logger.warn('slack notification job failed', {
      jobId: job?.id,
      userId: job?.data.userId,
      attemptsMade: job?.attemptsMade,
      error: err.message,
    }),
  );
  worker.on('error', (err) => logger.error('slack worker error', { err }));
  return worker;
}

export type SlackNotificationWorker = ReturnType<typeof createSlackNotificationWorker>;
