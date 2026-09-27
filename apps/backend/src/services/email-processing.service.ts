import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { env } from '../config/env.js';
import { emitHourlyLimitReached } from '../events/email-events.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type { EmailJobData } from '../queue/email.queue.js';
import { DeliveryRejectedError, type DeliveryResult, type EmailDeliveryService } from './email-delivery.service.js';
import type { SendRateLimiter } from './rate-limit/send-rate-limiter.js';

// Decides what to do with one email job, using PostgreSQL as the source of
// truth.
//
//   SCHEDULED --claim(token)--> PROCESSING
//     --rate limiter: reserve slot + acquire send gate (Redis)-->
//        deferred  -> SCHEDULED again with scheduledAt = slot (job re-delayed;
//                     an hourly-limit deferral also bumps reschedule metadata)
//        acquired  -> deliveryStartedAt = gate time, attempts + 1 --> [SMTP]
//     success            -> SENT
//     DeliveryRejected   -> FAILED            (definitively not accepted)
//     any other error    -> DELIVERY_UNKNOWN  (may have been accepted)
//
// The delivery ambiguity: an SMTP server can accept a message and the process
// can die before PostgreSQL records SENT. From the database alone that is
// indistinguishable from dying just before acceptance. So:
//  - deliveryStartedAt is written immediately BEFORE the SMTP interaction. If
//    it is null, the message was provably never handed over and the claim can
//    be released safely.
//  - if it is set and no outcome was recorded, the email becomes
//    DELIVERY_UNKNOWN and is never resent automatically.
// Delivery is therefore at-most-once, never exactly-once.
//
// Every write after the claim is conditional on the claim's token, so a
// claimant whose claim was recovered cannot overwrite a newer attempt.

export type ProcessEmailResult =
  | { outcome: 'delivered'; emailId: string; providerMessageId: string }
  | { outcome: 'skipped'; emailId: string; reason: SkipReason; status?: string }
  | { outcome: 'not_due'; emailId: string; scheduledAt: string }
  | { outcome: 'rescheduled'; emailId: string; scheduledAt: string; reason: 'hourly_limit' | 'min_delay' };

type SkipReason =
  | 'not_found'
  | 'already_terminal'
  | 'already_processing'
  | 'not_claimed'
  | 'claim_lost'
  | 'delivery_unknown'
  | 'campaign_cancelled';

export interface ProcessEmailDeps {
  delivery: EmailDeliveryService;
  rateLimiter: SendRateLimiter;
}

export interface ProcessEmailContext {
  // True when this job was activated before (BullMQ retry, stalled re-run or
  // re-delay). Only then is a PROCESSING row known to be an orphaned claim of
  // this same job; otherwise it belongs to someone else and is left alone.
  isRerun: boolean;
}

const TERMINAL = new Set(['SENT', 'FAILED', 'CANCELLED', 'DELIVERY_UNKNOWN']);

// A job may fire slightly before scheduledAt due to timer granularity. Early
// firing never breaks spacing: the send gate is checked separately.
const EARLY_TOLERANCE_MS = 1_000;

export type ClaimRecovery = 'released' | 'delivery_unknown' | 'noop';

// Resolves an orphaned PROCESSING claim. Callers must only use this when no
// live worker holds the claim (see ProcessEmailContext and reconcileEmailJobs).
export async function recoverInterruptedClaim(emailId: string, token: string | null): Promise<ClaimRecovery> {
  if (!token) return 'noop';
  const log = logger.child({ emailId });

  const released = await prisma.email.updateMany({
    where: { id: emailId, status: 'PROCESSING', processingToken: token, deliveryStartedAt: null },
    data: { status: 'SCHEDULED', processingToken: null },
  });
  if (released.count > 0) {
    log.warn('interrupted claim released: delivery had not started, email is SCHEDULED again');
    return 'released';
  }

  const unknown = await prisma.email.updateMany({
    where: { id: emailId, status: 'PROCESSING', processingToken: token, deliveryStartedAt: { not: null } },
    data: {
      status: 'DELIVERY_UNKNOWN',
      errorCode: 'DELIVERY_OUTCOME_UNKNOWN',
      errorMessage: 'Processing stopped after delivery started; outcome unknown. Not retried automatically.',
    },
  });
  if (unknown.count > 0) {
    log.error('interrupted claim after delivery started: marked DELIVERY_UNKNOWN, not retried');
    return 'delivery_unknown';
  }
  return 'noop';
}

// Outcome writes. Each applies only to the attempt that owns `token` and
// returns false (changing nothing) for a stale token.

export async function markSent(emailId: string, token: string, result: DeliveryResult): Promise<boolean> {
  // DELIVERY_UNKNOWN is accepted too: a definitive success from this claim
  // resolves an ambiguity recorded while it was stalled.
  const r = await prisma.email.updateMany({
    where: { id: emailId, processingToken: token, status: { in: ['PROCESSING', 'DELIVERY_UNKNOWN'] } },
    data: {
      status: 'SENT',
      sentAt: new Date(),
      providerMessageId: result.providerMessageId,
      previewUrl: result.previewUrl ?? null,
      errorCode: null,
      errorMessage: null,
    },
  });
  return r.count > 0;
}

export async function markFailed(emailId: string, token: string, code: string, message: string): Promise<boolean> {
  const r = await prisma.email.updateMany({
    where: { id: emailId, processingToken: token, status: 'PROCESSING' },
    data: { status: 'FAILED', errorCode: code, errorMessage: message.slice(0, 1_000) },
  });
  return r.count > 0;
}

export async function markDeliveryUnknown(emailId: string, token: string, message: string): Promise<boolean> {
  const r = await prisma.email.updateMany({
    where: { id: emailId, processingToken: token, status: 'PROCESSING', deliveryStartedAt: { not: null } },
    data: { status: 'DELIVERY_UNKNOWN', errorCode: 'DELIVERY_OUTCOME_UNKNOWN', errorMessage: message.slice(0, 1_000) },
  });
  return r.count > 0;
}

export async function processEmail(
  data: EmailJobData,
  { delivery, rateLimiter }: ProcessEmailDeps,
  { isRerun }: ProcessEmailContext = { isRerun: false },
): Promise<ProcessEmailResult> {
  const log = logger.child({ emailId: data.emailId, campaignId: data.campaignId, senderId: data.senderId });

  let email = await loadEmail(data.emailId);

  if (!email) {
    log.warn('email not found, skipping job');
    return { outcome: 'skipped', emailId: data.emailId, reason: 'not_found' };
  }

  if (email.userId !== data.userId || email.campaignId !== data.campaignId || email.senderId !== data.senderId) {
    throw new UnrecoverableError('Job data does not match the email record');
  }

  if (TERMINAL.has(email.status)) {
    log.info('email already terminal, skipping job', { status: email.status });
    return { outcome: 'skipped', emailId: email.id, reason: 'already_terminal', status: email.status };
  }

  if (email.status === 'PROCESSING') {
    if (!isRerun) {
      log.warn('email is PROCESSING under another claim, skipping');
      return { outcome: 'skipped', emailId: email.id, reason: 'already_processing', status: email.status };
    }
    // This job ran before and died mid-attempt: resolve its orphaned claim.
    const recovery = await recoverInterruptedClaim(email.id, email.processingToken);
    if (recovery === 'delivery_unknown') {
      return { outcome: 'skipped', emailId: email.id, reason: 'delivery_unknown', status: 'DELIVERY_UNKNOWN' };
    }
    if (recovery === 'noop') {
      return { outcome: 'skipped', emailId: email.id, reason: 'not_claimed' };
    }
    email = (await loadEmail(email.id))!;
  }

  if (email.scheduledAt.getTime() - Date.now() > EARLY_TOLERANCE_MS) {
    // The row was moved later than this job's delay; the row wins.
    return { outcome: 'not_due', emailId: email.id, scheduledAt: email.scheduledAt.toISOString() };
  }

  const token = randomUUID();
  // The claim also requires the campaign not to be cancelled, in the same
  // statement: cancellation and claiming cannot both win for one email.
  const claimed = await prisma.email.updateMany({
    where: { id: email.id, status: 'SCHEDULED', campaign: { status: { not: 'CANCELLED' } } },
    data: { status: 'PROCESSING', processingToken: token, deliveryStartedAt: null },
  });
  if (claimed.count === 0) {
    const campaign = await prisma.campaign.findUnique({ where: { id: email.campaignId }, select: { status: true } });
    if (campaign?.status === 'CANCELLED') {
      // E.g. an email that was deferred back to SCHEDULED while its campaign was cancelled.
      await prisma.email.updateMany({ where: { id: email.id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
      log.info('campaign cancelled; email cancelled instead of sent');
      return { outcome: 'skipped', emailId: email.id, reason: 'campaign_cancelled' };
    }
    log.info('email claimed by another job, skipping');
    return { outcome: 'skipped', emailId: email.id, reason: 'not_claimed' };
  }

  if (!email.sender.isActive) {
    await markFailed(email.id, token, 'SENDER_INACTIVE', 'Sender is inactive');
    log.warn('email marked FAILED', { errorCode: 'SENDER_INACTIVE' });
    throw new UnrecoverableError('Sender is inactive');
  }

  const decision = await rateLimiter.acquire({
    emailId: email.id,
    senderId: email.senderId,
    campaignId: email.campaignId,
    delayMs: Math.max(env.MIN_SEND_DELAY_MS, email.campaign.delayBetweenEmailsMs),
    senderHourlyLimit: Math.min(email.sender.hourlyLimit, env.MAX_EMAILS_PER_HOUR_PER_SENDER ?? Infinity),
    campaignHourlyLimit: email.campaign.hourlyLimit,
  });

  if (decision.kind === 'deferred') {
    // Put the email back, still eligible, at its reserved slot. Nothing was
    // sent, so releasing the claim is safe.
    const released = await prisma.email.updateMany({
      where: { id: email.id, status: 'PROCESSING', processingToken: token },
      data: {
        status: 'SCHEDULED',
        processingToken: null,
        scheduledAt: decision.until,
        ...(decision.limited ? { rescheduleCount: { increment: 1 }, lastRescheduledAt: new Date() } : {}),
      },
    });
    if (released.count === 0) {
      log.warn('claim superseded while deferring, skipping');
      return { outcome: 'skipped', emailId: email.id, reason: 'claim_lost' };
    }
    const reason = decision.limited ? 'hourly_limit' : 'min_delay';
    log.info('email rescheduled', {
      reason,
      scope: decision.scope,
      scheduledAt: decision.until.toISOString(),
      previousScheduledAt: email.scheduledAt.toISOString(),
    });
    if (decision.limited && decision.notify) {
      emitHourlyLimitReached({
        userId: email.userId,
        senderId: email.senderId,
        campaignId: email.campaignId,
        emailId: email.id,
        scope: decision.scope ?? 'sender',
        windowStart: decision.limitedWindowStart ?? new Date(),
        nextSlotAt: decision.until,
      });
    }
    return { outcome: 'rescheduled', emailId: email.id, scheduledAt: decision.until.toISOString(), reason };
  }

  // Point of no return: from here a crash leaves the outcome ambiguous.
  // deliveryStartedAt records the moment the send gate authorized this send.
  const started = await prisma.email.updateMany({
    where: { id: email.id, status: 'PROCESSING', processingToken: token },
    data: { deliveryStartedAt: decision.at, attempts: { increment: 1 }, lastAttemptAt: new Date() },
  });
  if (started.count === 0) {
    log.warn('claim superseded before delivery started, not delivering');
    return { outcome: 'skipped', emailId: email.id, reason: 'claim_lost' };
  }

  log.info('smtp send started', { authorizedAt: decision.at.toISOString() });
  let result: DeliveryResult;
  try {
    result = await delivery.deliver({
      id: email.id,
      userId: email.userId,
      senderId: email.senderId,
      recipientEmail: email.recipientEmail,
      subject: email.subject,
      body: email.body,
      idempotencyKey: email.idempotencyKey,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof DeliveryRejectedError) {
      log.warn('smtp send rejected', { errorCode: err.code, error: message });
      await markFailed(email.id, token, err.code, message);
      log.warn('email marked FAILED', { errorCode: err.code });
      throw new UnrecoverableError(`Delivery rejected: ${message}`);
    }
    // The provider may have accepted the message: never resend automatically.
    const code = (err as { code?: string }).code;
    await markDeliveryUnknown(email.id, token, message);
    log.error('delivery unknown; marked DELIVERY_UNKNOWN, not retried', { errorCode: code, error: message });
    throw new UnrecoverableError(`Delivery outcome unknown: ${message}`);
  }

  log.info('smtp send succeeded', { providerMessageId: result.providerMessageId, previewUrl: result.previewUrl });
  if (await markSent(email.id, token, result)) {
    log.info('email marked SENT', { providerMessageId: result.providerMessageId });
  } else {
    log.error('delivered but the row no longer belongs to this claim; SENT not recorded', {
      providerMessageId: result.providerMessageId,
    });
  }

  return { outcome: 'delivered', emailId: email.id, providerMessageId: result.providerMessageId };
}

function loadEmail(id: string) {
  return prisma.email.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      campaignId: true,
      senderId: true,
      recipientEmail: true,
      subject: true,
      body: true,
      status: true,
      scheduledAt: true,
      idempotencyKey: true,
      processingToken: true,
      campaign: { select: { delayBetweenEmailsMs: true, hourlyLimit: true } },
      sender: { select: { hourlyLimit: true, isActive: true } },
    },
  });
}
