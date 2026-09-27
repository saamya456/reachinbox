import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { emailJobId, getEmailQueue, SEND_EMAIL_JOB, type EmailQueue } from '../queue/email.queue.js';
import { recoverInterruptedClaim } from './email-processing.service.js';

// Turns a persisted Email row into a BullMQ delayed job.
//
// Consistency: the Email row is written (and committed) first, then the job is
// added. The two writes are not atomic. If adding the job fails, the email
// stays SCHEDULED in PostgreSQL without a job. reconcileEmailJobs repairs that:
// the worker runs it once at startup, and `npm run queue:reconcile` runs it on
// demand. The deterministic job id makes repeating it safe. No timer or
// polling loop is involved.

export class EmailNotFoundError extends Error {
  constructor(emailId: string) {
    super(`Email ${emailId} not found`);
    this.name = 'EmailNotFoundError';
  }
}

export class EmailNotSchedulableError extends Error {
  constructor(emailId: string, status: string) {
    super(`Email ${emailId} has status ${status}; only SCHEDULED emails can be queued`);
    this.name = 'EmailNotSchedulableError';
  }
}

export interface ScheduleEmailResult {
  emailId: string;
  jobId: string;
  status: 'scheduled' | 'already_scheduled';
  delayMs: number;
}

export async function scheduleEmail(
  emailId: string,
  queue: EmailQueue = getEmailQueue(),
): Promise<ScheduleEmailResult> {
  const email = await prisma.email.findUnique({
    where: { id: emailId },
    select: { id: true, userId: true, campaignId: true, senderId: true, status: true, scheduledAt: true },
  });
  if (!email) throw new EmailNotFoundError(emailId);
  if (email.status !== 'SCHEDULED') throw new EmailNotSchedulableError(emailId, email.status);

  const jobId = emailJobId(email.id);
  const delayMs = Math.max(0, email.scheduledAt.getTime() - Date.now());

  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state !== 'completed' && state !== 'failed') {
      return { emailId, jobId, status: 'already_scheduled', delayMs };
    }
    // A finished job still holds the id while the DB says the email needs
    // sending (e.g. the placeholder delivery released it); replace it.
    await existing.remove();
  }

  // If a concurrent call added the same id in between, BullMQ ignores this add.
  await queue.add(
    SEND_EMAIL_JOB,
    { emailId: email.id, userId: email.userId, campaignId: email.campaignId, senderId: email.senderId },
    { jobId, delay: delayMs },
  );

  logger.info('email job scheduled', {
    emailId: email.id,
    campaignId: email.campaignId,
    jobId,
    delayMs,
    scheduledAt: email.scheduledAt.toISOString(),
  });
  return { emailId, jobId, status: 'scheduled', delayMs };
}

export interface NewEmailJob {
  id: string;
  userId: string;
  campaignId: string;
  senderId: string;
  scheduledAt: Date;
}

// Bulk variant of scheduleEmail for emails that were JUST inserted (so no job
// can exist yet): one addBulk per 500 emails, same deterministic job ids.
// A chunk whose add fails is counted, not thrown: those emails stay
// SCHEDULED in PostgreSQL and are queued by reconciliation (worker startup
// or `npm run queue:reconcile`), because BullMQ ignores ids that already exist.
export async function scheduleNewEmails(
  emails: NewEmailJob[],
  queue: EmailQueue = getEmailQueue(),
): Promise<{ queued: number; failed: number }> {
  let queued = 0;
  let failed = 0;
  for (let i = 0; i < emails.length; i += 500) {
    const chunk = emails.slice(i, i + 500);
    const now = Date.now();
    try {
      await queue.addBulk(
        chunk.map((e) => ({
          name: SEND_EMAIL_JOB,
          data: { emailId: e.id, userId: e.userId, campaignId: e.campaignId, senderId: e.senderId },
          opts: { jobId: emailJobId(e.id), delay: Math.max(0, e.scheduledAt.getTime() - now) },
        })),
      );
      queued += chunk.length;
    } catch (err) {
      failed += chunk.length;
      logger.error('bulk scheduling failed; emails left for reconciliation', { err, emails: chunk.length });
    }
  }
  if (queued) logger.info('email jobs scheduled (bulk)', { queued, campaignId: emails[0]?.campaignId });
  return { queued, failed };
}

// Job states in which a job will still run (or is running) and therefore owns
// its email. Any other state (completed, failed, or no job) means no worker
// will touch the email again unless reconciliation acts.
const LIVE_JOB_STATES = new Set(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children']);

export interface ReconcileOptions {
  queue?: EmailQueue;
  // Limit to one tenant (targeted repair; also keeps tests isolated).
  userId?: string;
  batchSize?: number;
}

export interface ReconcileResult {
  // Pass 1: orphaned PROCESSING claims.
  claimsReleased: number;
  claimsDeliveryUnknown: number;
  claimsInFlight: number;
  // Pass 2: SCHEDULED emails.
  scheduled: number;
  alreadyScheduled: number;
}

// One reconciliation pass between PostgreSQL and BullMQ. Idempotent: running it
// again, or concurrently, creates no duplicate jobs and resolves each orphaned
// claim at most once (all writes are conditional on status and claim token).
export async function reconcileEmailJobs({
  queue = getEmailQueue(),
  userId,
  batchSize = 500,
}: ReconcileOptions = {}): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    claimsReleased: 0,
    claimsDeliveryUnknown: 0,
    claimsInFlight: 0,
    scheduled: 0,
    alreadyScheduled: 0,
  };

  // Pass 1 first, so claims released here are queued by pass 2.
  for await (const email of iterateEmails('PROCESSING', userId, batchSize)) {
    const job = await queue.getJob(emailJobId(email.id));
    const state = job ? await job.getState() : 'missing';
    if (LIVE_JOB_STATES.has(state)) {
      // A worker holds it, or the job will re-run and recover the claim itself.
      result.claimsInFlight++;
      continue;
    }
    const recovery = await recoverInterruptedClaim(email.id, email.processingToken);
    if (recovery === 'released') result.claimsReleased++;
    else if (recovery === 'delivery_unknown') result.claimsDeliveryUnknown++;
  }

  for await (const email of iterateEmails('SCHEDULED', userId, batchSize)) {
    try {
      const scheduled = await scheduleEmail(email.id, queue);
      if (scheduled.status === 'scheduled') result.scheduled++;
      else result.alreadyScheduled++;
    } catch (err) {
      // Status changed since the query (e.g. processed meanwhile): nothing to do.
      if (!(err instanceof EmailNotSchedulableError || err instanceof EmailNotFoundError)) throw err;
    }
  }

  return result;
}

// Keyset pagination in (scheduledAt, id) order, so jobs are enqueued in
// scheduling order (BullMQ runs equal-time jobs in insertion order). Rows may
// leave the status set while iterating.
async function* iterateEmails(status: 'SCHEDULED' | 'PROCESSING', userId: string | undefined, batchSize: number) {
  let last: { scheduledAt: Date; id: string } | undefined;
  for (;;) {
    const batch = await prisma.email.findMany({
      where: {
        status,
        ...(userId ? { userId } : {}),
        ...(last
          ? { OR: [{ scheduledAt: { gt: last.scheduledAt } }, { scheduledAt: last.scheduledAt, id: { gt: last.id } }] }
          : {}),
      },
      select: { id: true, processingToken: true, scheduledAt: true },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
    });
    if (batch.length === 0) return;
    yield* batch;
    last = batch[batch.length - 1]!;
  }
}
