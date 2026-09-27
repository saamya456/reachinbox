import { createHash, randomUUID } from 'node:crypto';
import type { CampaignStatus, EmailStatus } from '../generated/prisma/client.js';
import { badRequest, notFound } from '../http/errors.js';
import { htmlToText, looksLikeHtml, sanitizeEmailHtml } from '../lib/html.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { emailJobId, getEmailQueue, type EmailQueue } from '../queue/email.queue.js';
import { scheduleNewEmails } from '../services/email-scheduler.service.js';
import {
  mergeRecipients,
  parseRecipientList,
  parseRecipientText,
  RECIPIENT_LIMITS,
  type ParsedRecipients,
} from './recipients.js';

// Campaigns (one compose submission = one campaign = one email per recipient).
//
// PostgreSQL is written first, in one transaction (campaign + all emails via
// chunked createMany). Jobs are then added to the existing BullMQ scheduler
// with the deterministic email-<id> job ids. If adding jobs fails, the emails
// are still SCHEDULED in PostgreSQL; the response says how many are pending,
// and reconciliation (worker startup / queue:reconcile) queues them.
//
// Campaign status is derived from the real email states (see deriveStatus);
// only CANCELLED is an explicit user decision.

export interface CreateCampaignInput {
  senderId: string;
  subject: string;
  body: string;
  recipients: string[];
  recipientsText?: string;
  startAt: Date;
  timezone?: string;
  delayBetweenEmailsSeconds: number;
  hourlyLimit?: number;
  clientRequestId?: string;
}

export type EmailCounts = Record<EmailStatus, number>;

const EMPTY_COUNTS: EmailCounts = {
  SCHEDULED: 0,
  PROCESSING: 0,
  SENT: 0,
  FAILED: 0,
  CANCELLED: 0,
  DELIVERY_UNKNOWN: 0,
};

export function deriveStatus(stored: CampaignStatus, counts: EmailCounts): CampaignStatus {
  if (stored === 'CANCELLED') return 'CANCELLED';
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return 'DRAFT';
  const pending = counts.SCHEDULED + counts.PROCESSING;
  if (pending === 0) return 'COMPLETED';
  const started = counts.PROCESSING + counts.SENT + counts.FAILED + counts.DELIVERY_UNKNOWN + counts.CANCELLED;
  return started > 0 ? 'RUNNING' : 'SCHEDULED';
}

async function countsFor(userId: string, campaignIds: string[]): Promise<Map<string, EmailCounts>> {
  const rows = await prisma.email.groupBy({
    by: ['campaignId', 'status'],
    where: { userId, campaignId: { in: campaignIds } },
    _count: { _all: true },
  });
  const map = new Map<string, EmailCounts>();
  for (const id of campaignIds) map.set(id, { ...EMPTY_COUNTS });
  for (const r of rows) map.get(r.campaignId)![r.status] = r._count._all;
  return map;
}

const campaignSelect = {
  id: true,
  subject: true,
  startAt: true,
  timezone: true,
  delayBetweenEmailsMs: true,
  hourlyLimit: true,
  status: true,
  totalEmails: true,
  createdAt: true,
  sender: { select: { id: true, email: true, displayName: true } },
} as const;

type CampaignRow = { id: string; status: CampaignStatus } & Record<string, unknown>;

// Adds counts + derived status, and stores a changed status (best effort).
async function withStatus<T extends CampaignRow>(userId: string, campaigns: T[]) {
  const counts = await countsFor(userId, campaigns.map((c) => c.id));
  return Promise.all(
    campaigns.map(async (c) => {
      const emailCounts = counts.get(c.id)!;
      const status = deriveStatus(c.status, emailCounts);
      if (status !== c.status) {
        await prisma.campaign.updateMany({ where: { id: c.id, userId, status: { not: 'CANCELLED' } }, data: { status } });
      }
      return { ...c, status, emailCounts };
    }),
  );
}

export function prepareBody(body: string): string {
  const prepared = looksLikeHtml(body) ? sanitizeEmailHtml(body) : body.trim();
  if (!htmlToText(prepared)) throw badRequest('Email body is empty', 'empty_body');
  return prepared;
}

export async function createCampaign(userId: string, input: CreateCampaignInput, queue: EmailQueue = getEmailQueue()) {
  if (input.clientRequestId) {
    const existing = await prisma.campaign.findFirst({ where: { userId, clientRequestId: input.clientRequestId }, select: campaignSelect });
    if (existing) return { created: false as const, campaign: (await withStatus(userId, [existing]))[0]!, recipients: null, queued: 0, pendingReconciliation: 0 };
  }

  const sender = await prisma.sender.findFirst({ where: { id: input.senderId, userId }, select: { id: true, isActive: true, hourlyLimit: true } });
  if (!sender) throw notFound('Sender');
  if (!sender.isActive) throw badRequest('Sender is inactive', 'sender_inactive');

  // Chips and the uploaded list are parsed separately (so a CSV header is
  // recognized), then merged with cross-source de-duplication.
  const recipients: ParsedRecipients = mergeRecipients(
    parseRecipientList(input.recipients),
    ...(input.recipientsText?.trim() ? [parseRecipientText(input.recipientsText)] : []),
  );
  if (recipients.invalid > 0) {
    throw badRequest(`${recipients.invalid} recipient(s) are invalid`, 'invalid_recipients', summarize(recipients));
  }
  if (recipients.valid === 0) throw badRequest('Add at least one recipient', 'no_recipients');
  if (recipients.valid > RECIPIENT_LIMITS.maxRecipients) {
    throw badRequest(`A campaign can have at most ${RECIPIENT_LIMITS.maxRecipients} recipients`, 'too_many_recipients');
  }

  const now = Date.now();
  if (input.startAt.getTime() < now - 60_000) throw badRequest('Start time is in the past', 'start_in_past');
  if (input.startAt.getTime() > now + 365 * 24 * 60 * 60 * 1000) throw badRequest('Start time is more than a year ahead', 'start_too_far');

  const body = prepareBody(input.body);
  const subject = input.subject.trim();
  const delayMs = input.delayBetweenEmailsSeconds * 1000;
  const campaignId = randomUUID();
  const startAt = new Date(Math.max(input.startAt.getTime(), now));

  // Planned time of email i: start + i * delay (the rate limiter still enforces
  // the delay and hourly limits at send time and reschedules when needed).
  const emails = recipients.emails.map((to, i) => {
    const scheduledAt = new Date(startAt.getTime() + i * delayMs);
    return {
      id: randomUUID(),
      userId,
      campaignId,
      senderId: sender.id,
      recipientEmail: to,
      subject,
      body,
      scheduledAt,
      originalScheduledAt: scheduledAt,
      // Deterministic per campaign + recipient (recipients are unique per campaign).
      idempotencyKey: createHash('sha256').update(`${campaignId}:${to}`).digest('hex'),
    };
  });

  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.campaign.create({
          data: {
            id: campaignId,
            userId,
            senderId: sender.id,
            subject,
            body,
            startAt,
            timezone: input.timezone ?? null,
            delayBetweenEmailsMs: delayMs,
            hourlyLimit: input.hourlyLimit ?? sender.hourlyLimit,
            status: 'SCHEDULED',
            totalEmails: emails.length,
            clientRequestId: input.clientRequestId ?? null,
          },
        });
        for (let i = 0; i < emails.length; i += 1_000) {
          await tx.email.createMany({ data: emails.slice(i, i + 1_000) });
        }
      },
      { timeout: 60_000 },
    );
  } catch (err) {
    // The same compose submission raced itself: return the campaign that won.
    if ((err as { code?: string }).code === 'P2002' && input.clientRequestId) {
      return createCampaign(userId, input, queue);
    }
    throw err;
  }

  const { queued, failed } = await scheduleNewEmails(emails, queue);
  logger.info('campaign created', { userId, campaignId, emails: emails.length, queued, pendingReconciliation: failed });

  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, select: campaignSelect });
  return {
    created: true as const,
    campaign: (await withStatus(userId, [campaign]))[0]!,
    recipients: summarize(recipients),
    queued,
    pendingReconciliation: failed,
  };
}

function summarize(r: ParsedRecipients) {
  return { total: r.total, valid: r.valid, invalid: r.invalid, duplicatesRemoved: r.duplicatesRemoved, invalidEntries: r.invalidEntries };
}

export async function listCampaigns(userId: string, limit = 50) {
  const campaigns = await prisma.campaign.findMany({
    where: { userId },
    select: campaignSelect,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return withStatus(userId, campaigns);
}

export async function getCampaign(userId: string, id: string, { page = 1, limit = 50 } = {}) {
  const campaign = await prisma.campaign.findFirst({ where: { id, userId }, select: campaignSelect });
  if (!campaign) throw notFound('Campaign');
  const [withCounts] = await withStatus(userId, [campaign]);
  const emails = await prisma.email.findMany({
    where: { campaignId: id, userId },
    select: {
      id: true,
      recipientEmail: true,
      status: true,
      scheduledAt: true,
      // When the send was authorized by the rate limiter (minimum-delay gate).
      deliveryStartedAt: true,
      sentAt: true,
      rescheduleCount: true,
      previewUrl: true,
      errorCode: true,
    },
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    skip: (page - 1) * limit,
    take: limit,
  });
  return { ...withCounts!, emails, page, limit };
}

// Cancels every email that has not been claimed yet. Emails already being
// processed or sent are left alone (they may already be at the SMTP server).
// Safe against workers: both the UPDATE below and the worker's claim require
// status = SCHEDULED, and the claim also refuses a cancelled campaign, so an
// email is either cancelled or claimed, never both.
export async function cancelCampaign(userId: string, id: string, queue: EmailQueue = getEmailQueue()) {
  const campaign = await prisma.campaign.findFirst({ where: { id, userId }, select: { id: true } });
  if (!campaign) throw notFound('Campaign');

  const cancelled = await prisma.$transaction(async (tx) => {
    await tx.campaign.update({ where: { id_userId: { id, userId } }, data: { status: 'CANCELLED' } });
    return tx.$queryRaw<{ id: string }[]>`
      UPDATE emails SET status = 'CANCELLED', updated_at = now()
      WHERE campaign_id = ${id}::uuid AND user_id = ${userId}::uuid AND status = 'SCHEDULED'
      RETURNING id`;
  });

  // Remove their delayed jobs (best effort: a remaining job just finds the
  // email CANCELLED and skips it).
  let jobsRemoved = 0;
  for (let i = 0; i < cancelled.length; i += 100) {
    const results = await Promise.allSettled(cancelled.slice(i, i + 100).map((e) => queue.remove(emailJobId(e.id))));
    jobsRemoved += results.filter((r) => r.status === 'fulfilled' && r.value === 1).length;
  }
  logger.info('campaign cancelled', { userId, campaignId: id, emailsCancelled: cancelled.length, jobsRemoved });
  return { cancelledEmails: cancelled.length, jobsRemoved, campaign: await getCampaign(userId, id, { limit: 0 }) };
}
