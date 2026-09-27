import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { publicSenderSelect } from '../db/selects.js';
import { badRequest, conflict, notFound } from '../http/errors.js';
import { encryptSecret } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { assertAllowedSmtpPort, resolvePublicSmtpHost, SmtpHostError } from '../security/smtp-host.js';
import { createEtherealAccount } from '../services/ethereal.js';

// Sender (SMTP account) management, always scoped to the signed-in user.
// Request bodies are strict: unknown fields (e.g. "userId") are rejected, and
// the owner is always req.auth.userId. Another user's sender is reported as
// 404. Responses use publicSenderSelect, which never includes the password.

const senderFields = {
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(100).nullable(),
  smtpHost: z.string().trim().min(1).max(253),
  smtpPort: z.number().int(),
  smtpSecure: z.boolean(),
  smtpUser: z.string().trim().min(1).max(254),
  smtpPassword: z.string().min(1).max(512),
  hourlyLimit: z.number().int().min(1).max(10_000),
};

const createSchema = z.strictObject({
  ...senderFields,
  displayName: senderFields.displayName.optional(),
  smtpSecure: senderFields.smtpSecure.default(false),
});

const updateSchema = z
  .strictObject({ ...senderFields, isActive: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const etherealSchema = z.strictObject({
  displayName: senderFields.displayName.optional(),
  hourlyLimit: senderFields.hourlyLimit.default(100),
});

const idParam = z.object({ id: z.uuid() });

// Server-side SSRF check (see security/smtp-host.ts). Returns the normalized host.
async function checkSmtpTarget(host: string, port: number): Promise<string> {
  try {
    assertAllowedSmtpPort(port);
    return (await resolvePublicSmtpHost(host)).host;
  } catch (err) {
    if (err instanceof SmtpHostError) throw badRequest(err.message, err.code);
    throw err;
  }
}

function translateUnique(err: unknown): never {
  if ((err as { code?: string }).code === 'P2002') throw conflict('A sender with this email already exists');
  throw err;
}

async function findOwned(userId: string, rawId: unknown) {
  const parsed = idParam.safeParse({ id: rawId });
  if (!parsed.success) throw notFound('Sender');
  const sender = await prisma.sender.findFirst({
    where: { id: parsed.data.id, userId },
    select: { id: true, smtpHost: true, smtpPort: true },
  });
  if (!sender) throw notFound('Sender');
  return sender;
}

export function createSendersRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const senders = await prisma.sender.findMany({
      where: { userId: req.auth!.userId },
      select: publicSenderSelect,
      orderBy: { createdAt: 'asc' },
    });
    res.json(senders);
  });

  router.post('/', async (req, res) => {
    const input = createSchema.parse(req.body);
    const smtpHost = await checkSmtpTarget(input.smtpHost, input.smtpPort);
    const { smtpPassword, ...rest } = input;
    const sender = await prisma.sender
      .create({
        data: {
          ...rest,
          email: rest.email.toLowerCase(),
          smtpHost,
          userId: req.auth!.userId,
          smtpPasswordEncrypted: encryptSecret(smtpPassword),
        },
        select: publicSenderSelect,
      })
      .catch(translateUnique);
    logger.info('sender created', { userId: req.auth!.userId, senderId: sender.id });
    res.status(201).json(sender);
  });

  // Convenience for development/demo: a fresh Ethereal test account.
  router.post('/ethereal', async (req, res) => {
    const input = etherealSchema.parse(req.body ?? {});
    const account = await createEtherealAccount();
    const smtpHost = await checkSmtpTarget(account.smtp.host, account.smtp.port);
    const sender = await prisma.sender
      .create({
        data: {
          userId: req.auth!.userId,
          email: account.user.toLowerCase(),
          displayName: input.displayName ?? null,
          smtpHost,
          smtpPort: account.smtp.port,
          smtpSecure: account.smtp.secure,
          smtpUser: account.user,
          smtpPasswordEncrypted: encryptSecret(account.pass),
          hourlyLimit: input.hourlyLimit,
        },
        select: publicSenderSelect,
      })
      .catch(translateUnique);
    logger.info('ethereal sender created', { userId: req.auth!.userId, senderId: sender.id });
    res.status(201).json(sender);
  });

  router.get('/:id', async (req, res) => {
    const userId = req.auth!.userId;
    const { id } = await findOwned(userId, req.params.id);
    res.json(await prisma.sender.findUniqueOrThrow({ where: { id_userId: { id, userId } }, select: publicSenderSelect }));
  });

  router.patch('/:id', async (req, res) => {
    const userId = req.auth!.userId;
    const existing = await findOwned(userId, req.params.id);
    const input = updateSchema.parse(req.body);
    const { smtpPassword, ...rest } = input;

    const data: Record<string, unknown> = { ...rest };
    if (rest.email) data.email = rest.email.toLowerCase();
    if (rest.smtpHost !== undefined || rest.smtpPort !== undefined) {
      data.smtpHost = await checkSmtpTarget(rest.smtpHost ?? existing.smtpHost, rest.smtpPort ?? existing.smtpPort);
    }
    if (smtpPassword !== undefined) data.smtpPasswordEncrypted = encryptSecret(smtpPassword);

    const sender = await prisma.sender
      .update({ where: { id_userId: { id: existing.id, userId } }, data, select: publicSenderSelect })
      .catch(translateUnique);
    logger.info('sender updated', { userId, senderId: sender.id, fields: Object.keys(input) });
    res.json(sender);
  });

  // Deletes a sender with no email history; otherwise deactivates it (its
  // emails keep their history, and the database restricts deleting it).
  router.delete('/:id', async (req, res) => {
    const userId = req.auth!.userId;
    const { id } = await findOwned(userId, req.params.id);
    const emails = await prisma.email.count({ where: { senderId: id, userId } });
    if (emails > 0) {
      const sender = await prisma.sender.update({
        where: { id_userId: { id, userId } },
        data: { isActive: false },
        select: publicSenderSelect,
      });
      logger.info('sender deactivated', { userId, senderId: id });
      res.json({ outcome: 'deactivated', sender });
      return;
    }
    await prisma.sender.delete({ where: { id_userId: { id, userId } } });
    logger.info('sender deleted', { userId, senderId: id });
    res.json({ outcome: 'deleted', id });
  });

  return router;
}
