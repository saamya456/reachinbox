import { DelayedError, UnrecoverableError, Worker, type WorkerOptions } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { EmailDeliveryService } from '../services/email-delivery.service.js';
import { processEmail, type ProcessEmailResult } from '../services/email-processing.service.js';
import { getSendRateLimiter, type SendRateLimiter } from '../services/rate-limit/send-rate-limiter.js';
import { getSmtpDelivery } from '../services/smtp-delivery.service.js';
import { getRedisConnection } from './connection.js';
import { EMAIL_QUEUE_NAME, emailJobDataSchema, type EmailJobData, type QueueScope, type SEND_EMAIL_JOB } from './email.queue.js';

export interface EmailWorkerOptions extends QueueScope {
  // Defaults to WORKER_CONCURRENCY.
  concurrency?: number;
  // Defaults to real SMTP delivery.
  delivery?: EmailDeliveryService;
  // Defaults to the shared Redis-backed limiter (hourly windows).
  rateLimiter?: SendRateLimiter;
  // false: create paused and call worker.run() later (used for startup reconciliation).
  autorun?: boolean;
  // Stalled-job detection timing; the BullMQ defaults (30s) apply unless overridden (tests).
  stalled?: Pick<WorkerOptions, 'lockDuration' | 'stalledInterval'>;
}

export function createEmailWorker({
  prefix,
  concurrency,
  delivery = getSmtpDelivery(),
  rateLimiter = getSendRateLimiter(),
  autorun = true,
  stalled,
}: EmailWorkerOptions = {}) {
  const worker = new Worker<EmailJobData, ProcessEmailResult, typeof SEND_EMAIL_JOB>(
    EMAIL_QUEUE_NAME,
    async (job, token) => {
      const parsed = emailJobDataSchema.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError('Invalid email job data');
      const data = parsed.data;

      logger.info('email job started', {
        jobId: job.id,
        emailId: data.emailId,
        campaignId: data.campaignId,
        attempt: job.attemptsMade + 1,
        activation: job.attemptsStarted,
      });

      // attemptsStarted counts every activation (first run, retries, stalled
      // re-runs, re-delays), so > 1 means this job was activated before. A
      // PROCESSING row can then only be this job's own interrupted claim.
      const result = await processEmail(data, { delivery, rateLimiter }, { isRerun: job.attemptsStarted > 1 });

      if (result.outcome === 'not_due' || result.outcome === 'rescheduled') {
        // Move the same job (same deterministic id) back to delayed until the
        // persisted scheduledAt: a later time in PostgreSQL, or the slot the
        // rate limiter reserved. No new job is created.
        await job.moveToDelayed(new Date(result.scheduledAt).getTime(), token);
        logger.info('email job re-delayed', {
          jobId: job.id,
          emailId: data.emailId,
          campaignId: data.campaignId,
          scheduledAt: result.scheduledAt,
          reason: result.outcome === 'rescheduled' ? result.reason : 'not_due',
        });
        throw new DelayedError();
      }
      return result;
    },
    {
      connection: getRedisConnection(),
      prefix,
      concurrency: concurrency ?? env.WORKER_CONCURRENCY,
      autorun,
      ...stalled,
    },
  );

  worker.on('completed', (job, result) => {
    logger.info('email job completed', {
      jobId: job.id,
      emailId: job.data.emailId,
      campaignId: job.data.campaignId,
      outcome: result.outcome,
      ...(result.outcome === 'skipped' ? { reason: result.reason } : {}),
    });
  });

  worker.on('failed', (job, err) => {
    const maxAttempts = job?.opts.attempts ?? 1;
    logger.error('email job failed', {
      jobId: job?.id,
      emailId: job?.data.emailId,
      campaignId: job?.data.campaignId,
      attemptsMade: job?.attemptsMade,
      willRetry: !!job && !(err instanceof UnrecoverableError) && job.attemptsMade < maxAttempts,
      err,
    });
  });

  worker.on('stalled', (jobId) => logger.warn('email job stalled', { jobId }));
  worker.on('error', (err) => logger.error('email worker error', { err }));
  worker.on('ready', () => logger.info('email worker ready', { queue: EMAIL_QUEUE_NAME, concurrency: worker.concurrency }));
  worker.on('closed', () => logger.info('email worker closed', { queue: EMAIL_QUEUE_NAME }));

  return worker;
}

export type EmailWorker = ReturnType<typeof createEmailWorker>;
