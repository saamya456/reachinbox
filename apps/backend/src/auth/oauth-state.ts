import { randomBytes } from 'node:crypto';
import { getRedisConnection } from '../queue/connection.js';
import { hashToken } from './session.js';

// One-time OAuth `state` records, kept server-side in Redis for 10 minutes.
//
// The state value sent to the provider is random (256 bits) and carries no
// data itself. Its record says which flow it belongs to and what it is bound
// to (a browser cookie for Google login, the initiating session and user for
// Slack), plus the PKCE verifier and OIDC nonce. Consuming uses GETDEL, so a
// state can be used at most once, even by concurrent callbacks.

const TTL_SECONDS = 10 * 60;
const KEY_PREFIX = 'oauth:state:';

export interface OAuthStateRecord {
  provider: 'google' | 'slack';
  // SHA-256 of the value that must come back with the callback (browser
  // binding cookie for Google, session id for Slack).
  bindingHash: string;
  // Slack only: the user who started the flow.
  userId?: string;
  codeVerifier?: string;
  nonce?: string;
  returnTo: string;
}

export const randomToken = () => randomBytes(32).toString('base64url');

export async function createOAuthState(record: OAuthStateRecord): Promise<string> {
  const state = randomToken();
  await getRedisConnection().set(KEY_PREFIX + hashToken(state), JSON.stringify(record), 'EX', TTL_SECONDS);
  return state;
}

export async function consumeOAuthState(state: string): Promise<OAuthStateRecord | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
  const raw = await getRedisConnection().getdel(KEY_PREFIX + hashToken(state));
  return raw ? (JSON.parse(raw) as OAuthStateRecord) : null;
}

// Post-login destinations are paths on the frontend only: no scheme, no host,
// no protocol-relative "//", no backslashes. Anything else falls back to "/".
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  if (/[\u0000-\u001f]/.test(value)) return '/';
  return value;
}
