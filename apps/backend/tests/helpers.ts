// Shared helpers for the integration tests. Everything runs against the real
// Redis and PostgreSQL containers; isolation comes from per-test BullMQ and
// rate-limit key prefixes and throwaway users, all removed by cleanup().
import './setup.js';

import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import type { Prisma } from '../src/generated/prisma/client.js';
import { encryptSecret } from '../src/lib/crypto.js';
import { prisma } from '../src/lib/prisma.js';
import { closeRedisConnection, getRedisConnection } from '../src/queue/connection.js';
import { createEmailQueue, type EmailJobData, type EmailQueue } from '../src/queue/email.queue.js';
import { createEmailWorker, type EmailWorker, type EmailWorkerOptions } from '../src/queue/email.worker.js';
import type { DeliverableEmail, EmailDeliveryService } from '../src/services/email-delivery.service.js';
import type { ProcessEmailResult } from '../src/services/email-processing.service.js';
import { SendRateLimiter, type SendRateLimiterOptions } from '../src/services/rate-limit/send-rate-limiter.js';

export const run = randomUUID().slice(0, 8);
export const RL_PREFIX_ROOT = `test-${run}-rl`;

const userIds: string[] = [];
const queues: EmailQueue[] = [];
const workers: EmailWorker[] = [];
let counter = 0;

export function newQueue() {
  const prefix = `test-${run}-${++counter}`;
  const queue = createEmailQueue({ prefix });
  queues.push(queue);
  return { queue, prefix };
}

// Each limiter gets its own key prefix unless one is given (to share state).
export function newLimiter(options: SendRateLimiterOptions = {}) {
  return new SendRateLimiter({ keyPrefix: `${RL_PREFIX_ROOT}-${++counter}`, ...options });
}

export function newWorker(
  prefix: string,
  delivery?: EmailDeliveryService,
  options: Omit<EmailWorkerOptions, 'prefix' | 'delivery'> = {},
) {
  const worker = createEmailWorker({ prefix, delivery, rateLimiter: options.rateLimiter ?? newLimiter(), ...options });
  workers.push(worker);
  return worker;
}

export function trackWorker(worker: EmailWorker) {
  workers.push(worker);
  return worker;
}

export interface TenantOptions {
  senderHourlyLimit?: number;
  campaignHourlyLimit?: number;
  delayMs?: number;
  smtp?: { host: string; port: number; secure?: boolean; user: string; password: string; email?: string };
}

export async function makeTenant(options: TenantOptions = {}) {
  const label = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: { googleId: `google-${run}-${label}`, email: `${run}-${label}@example.com` },
  });
  userIds.push(user.id);
  const smtp = options.smtp;
  const senderEmail = smtp?.email ?? smtp?.user ?? `sender-${label}@ethereal.email`;
  const sender = await prisma.sender.create({
    data: {
      userId: user.id,
      email: senderEmail,
      smtpHost: smtp?.host ?? 'smtp.ethereal.email',
      smtpPort: smtp?.port ?? 587,
      smtpSecure: smtp?.secure ?? false,
      smtpUser: smtp?.user ?? senderEmail,
      smtpPasswordEncrypted: encryptSecret(smtp?.password ?? 'smtp-password-never-in-redis'),
      hourlyLimit: options.senderHourlyLimit ?? 100,
    },
  });
  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      subject: 'S',
      body: 'B',
      startAt: new Date(),
      delayBetweenEmailsMs: options.delayMs ?? 0,
      hourlyLimit: options.campaignHourlyLimit ?? 100,
    },
  });
  return { user, sender, campaign };
}

export type Tenant = Awaited<ReturnType<typeof makeTenant>>;

export async function makeEmail(t: Tenant, scheduledAt: Date, extra: Partial<Prisma.EmailUncheckedCreateInput> = {}) {
  return prisma.email.create({
    data: {
      userId: t.user.id,
      campaignId: t.campaign.id,
      senderId: t.sender.id,
      recipientEmail: 'rcpt@example.com',
      subject: 'S',
      body: 'B',
      scheduledAt,
      originalScheduledAt: scheduledAt,
      idempotencyKey: randomUUID(),
      ...extra,
    },
  });
}

export function jobData(t: Tenant, emailId: string): EmailJobData {
  return { emailId, userId: t.user.id, campaignId: t.campaign.id, senderId: t.sender.id };
}

// Records deliveries (with the local time of each call) without sending anything.
export function fakeDelivery(impl?: (email: DeliverableEmail) => Promise<void>) {
  const calls: DeliverableEmail[] = [];
  const times: number[] = [];
  const service: EmailDeliveryService = {
    async deliver(email) {
      calls.push(email);
      times.push(Date.now());
      await impl?.(email);
      return { providerMessageId: `<fake-${email.id}@test>` };
    },
  };
  return { service, calls, times };
}

export type JobEnd =
  | { state: 'completed'; job: Job<EmailJobData, ProcessEmailResult>; result: ProcessEmailResult }
  | { state: 'failed'; job: Job<EmailJobData, ProcessEmailResult> | undefined; error: Error };

// Resolves when the worker finishes (completes or fails) the given job. A job
// that is re-delayed is not "finished"; waiting continues until it is.
export function waitForJobEnd(worker: EmailWorker, jobId: string, timeoutMs = 15_000): Promise<JobEnd> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${jobId}`));
    }, timeoutMs);
    const onCompleted = (job: Job<EmailJobData, ProcessEmailResult>, result: ProcessEmailResult) => {
      if (job.id !== jobId) return;
      cleanup();
      resolve({ state: 'completed', job, result });
    };
    const onFailed = (job: Job<EmailJobData, ProcessEmailResult> | undefined, error: Error) => {
      if (job?.id !== jobId) return;
      cleanup();
      resolve({ state: 'failed', job, error });
    };
    function cleanup() {
      clearTimeout(timer);
      worker.off('completed', onCompleted);
      worker.off('failed', onFailed);
    }
    worker.on('completed', onCompleted);
    worker.on('failed', onFailed);
  });
}

// Resolves when any of the workers finishes the given job.
export function waitForJobEndAny(ws: EmailWorker[], jobId: string, timeoutMs = 15_000): Promise<JobEnd> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${jobId}`));
    }, timeoutMs);
    const handlers = ws.map((w) => {
      const onCompleted = (job: Job<EmailJobData, ProcessEmailResult>, result: ProcessEmailResult) => {
        if (job.id !== jobId) return;
        cleanup();
        resolve({ state: 'completed', job, result });
      };
      const onFailed = (job: Job<EmailJobData, ProcessEmailResult> | undefined, error: Error) => {
        if (job?.id !== jobId) return;
        cleanup();
        resolve({ state: 'failed', job, error });
      };
      w.on('completed', onCompleted);
      w.on('failed', onFailed);
      return { w, onCompleted, onFailed };
    });
    function cleanup() {
      clearTimeout(timer);
      for (const h of handlers) {
        h.w.off('completed', h.onCompleted);
        h.w.off('failed', h.onFailed);
      }
    }
  });
}

const extraCleanups: (() => Promise<unknown>)[] = [];

// Registers additional teardown (servers, other queues/workers); runs first.
export function onCleanup(fn: () => Promise<unknown>) {
  extraCleanups.push(fn);
}

// Users created outside makeTenant (e.g. by the OAuth flow) that must be removed.
export function trackUser(id: string) {
  userIds.push(id);
}

export async function cleanup() {
  for (const fn of extraCleanups) await fn();
  await Promise.all(workers.map((w) => w.close()));
  for (const q of queues) {
    await q.obliterate({ force: true });
    await q.close();
  }
  // Search outbox rows for this run's emails (the triggers also add a deletion
  // row for each email removed with its user below).
  const emailIds = (await prisma.email.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map((e) => e.id);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  for (let i = 0; i < emailIds.length; i += 5_000) {
    await prisma.searchOutbox.deleteMany({ where: { emailId: { in: emailIds.slice(i, i + 5_000) } } });
  }
  // Rate-limit keys of this run (including those written by child processes).
  const redis = getRedisConnection();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${RL_PREFIX_ROOT}*`, 'COUNT', 1000);
    if (keys.length) await redis.del(...keys);
    cursor = next;
  } while (cursor !== '0');
  // Sessions belonging to this run's users.
  const ours = new Set(userIds);
  cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'sess:*', 'COUNT', 1000);
    for (const key of keys) {
      const raw = await redis.get(key);
      if (raw && ours.has((JSON.parse(raw) as { userId: string }).userId)) await redis.del(key);
    }
    cursor = next;
  } while (cursor !== '0');
  await closeRedisConnection();
  await prisma.$disconnect();
}
