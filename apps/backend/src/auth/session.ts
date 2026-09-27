import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import { env } from '../config/env.js';
import { getRedisConnection } from '../queue/connection.js';

// Server-side sessions in Redis.
//
// The browser only holds an opaque, random 256-bit session id in an HttpOnly
// cookie; nothing about the user or any OAuth token is readable by JavaScript.
// Redis stores the session under the SHA-256 of that id, so a Redis dump does
// not contain usable cookies. Logout deletes the Redis entry, so the cookie
// stops working immediately even if a copy of it survives.

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const KEY_PREFIX = 'sess:';

export const isSecureCookie = env.NODE_ENV === 'production';
// The __Host- prefix makes the browser enforce Secure, Path=/ and no Domain.
export const SESSION_COOKIE = isSecureCookie ? '__Host-ri_sid' : 'ri_sid';

export function cookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: isSecureCookie,
    // Lax: sent on top-level navigations (needed for the OAuth redirect back
    // to us), not on cross-site subresource requests or cross-site POSTs.
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  };
}

export interface SessionData {
  userId: string;
  createdAt: string;
}

export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');

export async function createSession(userId: string): Promise<string> {
  const sessionId = randomBytes(32).toString('base64url');
  const data: SessionData = { userId, createdAt: new Date().toISOString() };
  await getRedisConnection().set(KEY_PREFIX + hashToken(sessionId), JSON.stringify(data), 'EX', SESSION_TTL_SECONDS);
  return sessionId;
}

export async function getSession(sessionId: string): Promise<SessionData | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(sessionId)) return null;
  const raw = await getRedisConnection().get(KEY_PREFIX + hashToken(sessionId));
  return raw ? (JSON.parse(raw) as SessionData) : null;
}

export async function destroySession(sessionId: string): Promise<void> {
  await getRedisConnection().del(KEY_PREFIX + hashToken(sessionId));
}

export function readSessionCookie(req: Request): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[SESSION_COOKIE];
  return typeof value === 'string' ? value : undefined;
}

export function setSessionCookie(res: Response, sessionId: string) {
  res.cookie(SESSION_COOKIE, sessionId, cookieOptions(SESSION_TTL_SECONDS * 1000));
}

export function clearSessionCookie(res: Response) {
  const { maxAge: _maxAge, ...options } = cookieOptions(0);
  res.clearCookie(SESSION_COOKIE, options);
}
