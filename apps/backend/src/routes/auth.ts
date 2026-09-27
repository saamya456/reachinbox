import { Router, type Response } from 'express';
import { z } from 'zod';
import { buildGoogleAuthorizationUrl, exchangeGoogleCode, OAuthFlowError, type GoogleOAuthConfig } from '../auth/google.js';
import { requireAuth } from '../auth/middleware.js';
import { consumeOAuthState, createOAuthState, randomToken, safeReturnPath } from '../auth/oauth-state.js';
import {
  clearSessionCookie,
  cookieOptions,
  createSession,
  destroySession,
  hashToken,
  readSessionCookie,
  setSessionCookie,
} from '../auth/session.js';
import { env } from '../config/env.js';
import { notConfigured, unauthorized } from '../http/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

// Google sign-in, session and logout.
//
// Login CSRF: /auth/google sets a random HttpOnly "binding" cookie and stores
// only its hash in the one-time state record. The callback accepts the state
// only from the browser holding that cookie, so a callback URL started by an
// attacker cannot log a victim into the attacker's account.

const BINDING_COOKIE = 'ri_oauth_google';
const BINDING_PATH = '/auth/google';

const callbackQuery = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(128).optional(),
  error: z.string().max(128).optional(),
});

const meSelect = { id: true, name: true, email: true, avatarUrl: true } as const;

export function createAuthRouter(google: GoogleOAuthConfig | null, adminEmails: string[] = []) {
  const admins = new Set(adminEmails.map((e) => e.toLowerCase()));
  const router = Router();

  router.get('/google', async (req, res) => {
    if (!google) throw notConfigured('Google sign-in');
    const binding = randomToken();
    const codeVerifier = randomToken();
    const nonce = randomToken();
    const state = await createOAuthState({
      provider: 'google',
      bindingHash: hashToken(binding),
      codeVerifier,
      nonce,
      returnTo: safeReturnPath(req.query.returnTo),
    });
    res.cookie(BINDING_COOKIE, binding, { ...cookieOptions(10 * 60 * 1000), path: BINDING_PATH });
    res.redirect(302, buildGoogleAuthorizationUrl(google, { state, nonce, codeVerifier }));
  });

  router.get('/google/callback', async (req, res) => {
    const fail = (code: string) => {
      clearBindingCookie(res);
      logger.warn('google sign-in rejected', { reason: code });
      res.redirect(302, `${env.APP_URL}/login?error=${encodeURIComponent(code)}`);
    };

    const query = callbackQuery.safeParse(req.query);
    if (!query.success) return fail('invalid_request');
    // Consume first: a state is single-use even when the provider reports an error.
    const record = query.data.state ? await consumeOAuthState(query.data.state) : null;
    if (query.data.error) return fail('access_denied');

    const binding = (req.cookies as Record<string, unknown>)[BINDING_COOKIE];
    if (
      !record ||
      record.provider !== 'google' ||
      typeof binding !== 'string' ||
      hashToken(binding) !== record.bindingHash ||
      !record.codeVerifier ||
      !record.nonce
    ) {
      return fail('invalid_state');
    }
    if (!query.data.code) return fail('invalid_request');
    if (!google) return fail('not_configured');

    let identity;
    try {
      identity = await exchangeGoogleCode(google, { code: query.data.code, codeVerifier: record.codeVerifier, nonce: record.nonce });
    } catch (err) {
      return fail(err instanceof OAuthFlowError ? err.code : 'sign_in_failed');
    }

    let user;
    try {
      user = await prisma.user.upsert({
        where: { googleId: identity.sub },
        create: { googleId: identity.sub, email: identity.email, name: identity.name, avatarUrl: identity.picture },
        update: { email: identity.email, name: identity.name, avatarUrl: identity.picture },
        select: { id: true },
      });
    } catch (err) {
      // Email already used by a different Google account.
      if ((err as { code?: string }).code === 'P2002') return fail('account_conflict');
      throw err;
    }

    // New session id on every login (no session fixation); drop any previous one.
    const previous = readSessionCookie(req);
    if (previous) await destroySession(previous);
    const sessionId = await createSession(user.id);
    setSessionCookie(res, sessionId);
    clearBindingCookie(res);
    logger.info('user signed in', { userId: user.id });
    res.redirect(302, `${env.APP_URL}${record.returnTo}`);
  });

  router.get('/me', requireAuth, async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: meSelect });
    if (!user) {
      // Session outlived its user.
      await destroySession(req.auth!.sessionId);
      clearSessionCookie(res);
      throw unauthorized();
    }
    // isAdmin only tells the frontend whether to show the queue dashboard link;
    // the dashboard itself enforces access on the server.
    res.json({ ...user, isAdmin: admins.has(user.email.toLowerCase()) });
  });

  router.post('/logout', async (req, res) => {
    const sessionId = readSessionCookie(req);
    if (sessionId) await destroySession(sessionId);
    clearSessionCookie(res);
    res.status(204).end();
  });

  return router;
}

function clearBindingCookie(res: Response) {
  const { maxAge: _maxAge, ...options } = cookieOptions(0);
  res.clearCookie(BINDING_COOKIE, { ...options, path: BINDING_PATH });
}
