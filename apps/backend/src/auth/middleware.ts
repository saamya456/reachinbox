import type { RequestHandler } from 'express';
import { env } from '../config/env.js';
import { forbidden, unauthorized } from '../http/errors.js';
import { getSession, readSessionCookie } from './session.js';

// Authentication: resolves the session cookie to exactly one local user and
// attaches it as req.auth. Routes take the tenant ONLY from req.auth; request
// bodies, params and queries are never a source of identity.

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const sessionId = readSessionCookie(req);
  const session = sessionId ? await getSession(sessionId) : null;
  if (!sessionId || !session) throw unauthorized();
  req.auth = { userId: session.userId, sessionId };
  next();
};

// CSRF defence in depth for cookie-authenticated state changes (SameSite=Lax
// already keeps the cookie off cross-site POSTs in current browsers): a
// request that states an Origin must come from the frontend or this server.
// Requests without an Origin (curl, server-to-server) carry no browser cookie
// risk and are allowed through to normal authentication.
const allowedOrigins = new Set([env.APP_URL, env.CORS_ORIGIN].map((u) => new URL(u).origin));
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const requireTrustedOrigin: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  const self = `${req.protocol}://${req.get('host')}`;
  if (allowedOrigins.has(origin) || origin === self) return next();
  throw forbidden('Cross-origin request rejected');
};
