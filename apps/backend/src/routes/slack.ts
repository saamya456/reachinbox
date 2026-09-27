import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { consumeOAuthState, createOAuthState, safeReturnPath } from '../auth/oauth-state.js';
import { getSession, hashToken, readSessionCookie } from '../auth/session.js';
import { env } from '../config/env.js';
import { notConfigured } from '../http/errors.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { buildSlackAuthorizeUrl, exchangeSlackCode, revokeSlackToken, type SlackOAuthConfig } from '../slack/slack-api.js';

// Slack connection for the signed-in user.
//
// Tenant binding: the one-time state records the user AND the session that
// started the flow; the callback only stores the connection if it arrives in
// that same session. A user id from the request is never used.
//
// One connection per user: connecting again replaces (and revokes) the old one.
// Tokens and the webhook URL are encrypted at rest and never returned.

const callbackQuery = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(128).optional(),
  error: z.string().max(128).optional(),
});

const STATUS_NAMES = { ACTIVE: 'connected', REVOKED: 'revoked', ERROR: 'error' } as const;

function redirectTarget(returnTo: string, result: string) {
  const url = new URL(returnTo, env.APP_URL);
  url.searchParams.set('slack', result);
  return url.toString();
}

async function revokeAll(config: SlackOAuthConfig | null, encryptedTokens: string[], keep?: string): Promise<boolean> {
  let allRevoked = true;
  for (const encrypted of encryptedTokens) {
    let token: string;
    try {
      token = decryptSecret(encrypted);
    } catch {
      continue;
    }
    // Slack may hand back the same token on reconnect; never revoke the live one.
    if (token === keep) continue;
    const revoked = config ? await revokeSlackToken(config, token) : false;
    allRevoked &&= revoked;
  }
  return allRevoked;
}

export function createSlackRouter(slack: SlackOAuthConfig | null) {
  const router = Router();

  router.get('/connect', requireAuth, async (req, res) => {
    if (!slack) throw notConfigured('Slack integration');
    const state = await createOAuthState({
      provider: 'slack',
      bindingHash: hashToken(req.auth!.sessionId),
      userId: req.auth!.userId,
      returnTo: safeReturnPath(req.query.returnTo),
    });
    res.redirect(302, buildSlackAuthorizeUrl(slack, state));
  });

  router.get('/callback', async (req, res) => {
    const query = callbackQuery.safeParse(req.query);
    const record = query.success && query.data.state ? await consumeOAuthState(query.data.state) : null;
    const done = (result: string) => {
      if (result !== 'connected') logger.warn('slack connect rejected', { reason: result });
      res.redirect(302, redirectTarget(record?.returnTo ?? '/', result));
    };
    if (!query.success) return done('invalid_request');
    if (query.data.error) return done('denied');

    const sessionId = readSessionCookie(req);
    const session = sessionId ? await getSession(sessionId) : null;
    if (
      !record ||
      record.provider !== 'slack' ||
      !sessionId ||
      !session ||
      hashToken(sessionId) !== record.bindingHash ||
      session.userId !== record.userId
    ) {
      return done('invalid_state');
    }
    if (!query.data.code) return done('invalid_request');
    if (!slack) return done('not_configured');

    let installation;
    try {
      installation = await exchangeSlackCode(slack, query.data.code);
    } catch {
      return done('error');
    }

    const userId = session.userId;
    const previous = await prisma.slackConnection.findMany({ where: { userId }, select: { accessTokenEncrypted: true } });
    await prisma.$transaction([
      prisma.slackConnection.deleteMany({ where: { userId } }),
      prisma.slackConnection.create({
        data: {
          userId,
          teamId: installation.teamId,
          teamName: installation.teamName,
          channelId: installation.channelId,
          channelName: installation.channelName,
          botUserId: installation.botUserId,
          scope: installation.scope,
          accessTokenEncrypted: encryptSecret(installation.accessToken),
          webhookUrlEncrypted: encryptSecret(installation.webhookUrl),
          status: 'ACTIVE',
        },
      }),
    ]);
    await revokeAll(slack, previous.map((p) => p.accessTokenEncrypted), installation.accessToken);
    logger.info('slack connected', { userId, teamId: installation.teamId, channelId: installation.channelId });
    done('connected');
  });

  router.get('/status', requireAuth, async (req, res) => {
    const connection = await prisma.slackConnection.findFirst({
      where: { userId: req.auth!.userId },
      orderBy: { createdAt: 'desc' },
      select: {
        status: true,
        teamName: true,
        channelName: true,
        createdAt: true,
        lastNotifiedAt: true,
        lastError: true,
      },
    });
    if (!connection) {
      res.json({ status: 'disconnected', configured: slack !== null });
      return;
    }
    res.json({
      status: STATUS_NAMES[connection.status],
      configured: slack !== null,
      teamName: connection.teamName,
      channelName: connection.channelName,
      connectedAt: connection.createdAt,
      lastNotifiedAt: connection.lastNotifiedAt,
      lastError: connection.status === 'ACTIVE' ? null : connection.lastError,
    });
  });

  // Removes the stored credentials (so no notification can use them) and
  // asks Slack to revoke the token. Local removal happens even if Slack is
  // unreachable; `revoked` reports whether Slack confirmed the revocation.
  router.post('/disconnect', requireAuth, async (req, res) => {
    const userId = req.auth!.userId;
    const connections = await prisma.slackConnection.findMany({ where: { userId }, select: { accessTokenEncrypted: true } });
    await prisma.slackConnection.deleteMany({ where: { userId } });
    const revoked = connections.length === 0 ? true : await revokeAll(slack, connections.map((c) => c.accessTokenEncrypted));
    logger.info('slack disconnected', { userId, removed: connections.length, revokedAtSlack: revoked });
    res.json({ status: 'disconnected', revoked });
  });

  return router;
}
