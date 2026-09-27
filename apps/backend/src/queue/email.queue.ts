import { Queue, type DefaultJobOptions } from 'bullmq';
import { z } from 'zod';
import type { ProcessEmailResult } from '../services/email-processing.service.js';
import { getRedisConnection } from './connection.js';

export const EMAIL_QUEUE_NAME = 'email-scheduler';
export const SEND_EMAIL_JOB = 'send-email';

// Identifiers only. The PostgreSQL Email row is the source of truth; the worker
// re-reads it and checks these ids against it. Never put secrets here.
export const emailJobDataSchema = z.strictObject({
  emailId: z.uuid(),
  userId: z.uuid(),
  campaignId: z.uuid(),
  senderId: z.uuid(),
});

export type EmailJobData = z.infer<typeof emailJobDataSchema>;

// Deterministic job id: one BullMQ job per Email row. BullMQ ignores an add()
// whose jobId already exists, so re-scheduling the same email (double submit,
// retry, restart, reconciliation) cannot create a second job. The email id is
// used rather than the idempotency key because it is an immutable UUID, while
// BullMQ forbids ':' in custom ids.
export const emailJobId = (emailId: string) => `email-${emailId}`;

// Retries cover infrastructure failures (DB/Redis unavailable before an email
// is claimed). Delivery outcomes are never retried blindly: the processing
// service fails those jobs with UnrecoverableError.
export const EMAIL_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

export interface QueueScope {
  // Redis key prefix; defaults to BullMQ's 'bull'. Tests use a unique prefix.
  prefix?: string;
}

export function createEmailQueue({ prefix }: QueueScope = {}) {
  return new Queue<EmailJobData, ProcessEmailResult, typeof SEND_EMAIL_JOB>(EMAIL_QUEUE_NAME, {
    connection: getRedisConnection(),
    prefix,
    defaultJobOptions: EMAIL_JOB_OPTIONS,
  });
}

export type EmailQueue = ReturnType<typeof createEmailQueue>;

let emailQueue: EmailQueue | undefined;

export function getEmailQueue(): EmailQueue {
  emailQueue ??= createEmailQueue();
  return emailQueue;
}

export async function closeEmailQueue(): Promise<void> {
  if (!emailQueue) return;
  const current = emailQueue;
  emailQueue = undefined;
  await current.close();
}
