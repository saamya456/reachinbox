import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { cancelCampaign, createCampaign, getCampaign, listCampaigns } from '../campaigns/campaign.service.js';
import { parseRecipientText, RECIPIENT_LIMITS, RecipientInputError } from '../campaigns/recipients.js';
import { badRequest, notFound } from '../http/errors.js';
import { bodyToSafeHtml } from '../lib/html.js';
import { prisma } from '../lib/prisma.js';
import { getEmailQueue, type EmailQueue } from '../queue/email.queue.js';

// Campaign (compose) and email read APIs, scoped to the signed-in user. The
// owner is always req.auth.userId; bodies are strict (unknown fields such as
// userId are rejected) and another tenant's resources are reported as 404.

const idParam = z.uuid();

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const createSchema = z
  .strictObject({
    senderId: z.uuid(),
    subject: z.string().trim().min(1, 'Subject is required').max(300),
    body: z.string().min(1, 'Body is required').max(200_000),
    // Addresses (chips); each entry may contain several separated addresses.
    recipients: z.array(z.string().max(1_000)).max(RECIPIENT_LIMITS.maxRecipients).default([]),
    // Raw CSV/text lead list content (never a file path).
    recipientsText: z.string().max(RECIPIENT_LIMITS.maxInputBytes).optional(),
    // Absolute instant with an explicit offset, e.g. 2026-10-01T09:00:00.000Z.
    startAt: z.iso.datetime({ offset: true }),
    timezone: z.string().max(64).refine(isTimeZone, 'Unknown time zone').optional(),
    delayBetweenEmailsSeconds: z.number().int().min(0).max(3_600),
    hourlyLimit: z.number().int().min(1).max(10_000).optional(),
    clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  })
  .refine((v) => v.recipients.length > 0 || !!v.recipientsText?.trim(), {
    message: 'Add at least one recipient',
    path: ['recipients'],
  });

const parseSchema = z.strictObject({ text: z.string().max(RECIPIENT_LIMITS.maxInputBytes) });

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function translateRecipientError(err: unknown): never {
  if (err instanceof RecipientInputError) throw badRequest(err.message, err.code);
  throw err;
}

export function createCampaignsRouter(getQueue: () => EmailQueue = getEmailQueue) {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    res.json(await listCampaigns(req.auth!.userId));
  });

  router.post('/', async (req, res) => {
    const input = createSchema.parse(req.body);
    const result = await createCampaign(
      req.auth!.userId,
      { ...input, startAt: new Date(input.startAt) },
      getQueue(),
    ).catch(translateRecipientError);
    res.status(result.created ? 201 : 200).json(result);
  });

  // Upload preview: the server parses the lead list (authoritative counts).
  router.post('/recipients/parse', async (req, res) => {
    const { text } = parseSchema.parse(req.body);
    let parsed;
    try {
      parsed = parseRecipientText(text);
    } catch (err) {
      translateRecipientError(err);
    }
    res.json({
      emails: parsed.emails.slice(0, RECIPIENT_LIMITS.maxRecipients),
      total: parsed.total,
      valid: parsed.valid,
      invalid: parsed.invalid,
      duplicatesRemoved: parsed.duplicatesRemoved,
      invalidEntries: parsed.invalidEntries,
      tooMany: parsed.valid > RECIPIENT_LIMITS.maxRecipients,
    });
  });

  router.get('/:id', async (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound('Campaign');
    res.json(await getCampaign(req.auth!.userId, id.data, pageQuery.parse(req.query)));
  });

  router.post('/:id/cancel', async (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound('Campaign');
    res.json(await cancelCampaign(req.auth!.userId, id.data, getQueue()));
  });

  return router;
}

export function createEmailsRouter() {
  const router = Router();
  router.use(requireAuth);

  // Email detail (from PostgreSQL, the source of truth). The body is served as
  // sanitized HTML; no credentials or internal fields are included.
  router.get('/:id', async (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound('Email');
    const email = await prisma.email.findFirst({
      where: { id: id.data, userId: req.auth!.userId },
      select: {
        id: true,
        campaignId: true,
        senderId: true,
        recipientEmail: true,
        subject: true,
        body: true,
        status: true,
        scheduledAt: true,
        originalScheduledAt: true,
        rescheduleCount: true,
        attempts: true,
        sentAt: true,
        providerMessageId: true,
        previewUrl: true,
        errorCode: true,
        errorMessage: true,
        createdAt: true,
        updatedAt: true,
        sender: { select: { id: true, email: true, displayName: true } },
        campaign: { select: { id: true, subject: true, status: true } },
      },
    });
    if (!email) throw notFound('Email');
    const { body, ...rest } = email;
    res.json({ ...rest, bodyHtml: bodyToSafeHtml(body) });
  });

  return router;
}
