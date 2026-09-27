import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { env } from '../config/env.js';

// Google sign-in: OAuth 2.0 authorization code flow + OpenID Connect.
//  - PKCE (S256) and a nonce on every request; state handled by oauth-state.ts.
//  - The ID token from the token endpoint is verified: RS256 signature against
//    Google's published keys (JWKS), issuer, audience (our client id), expiry
//    and nonce. Only a verified email is accepted.
//  - Only the identity claims are used. Google access/refresh tokens are not
//    stored anywhere.

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  issuers: string[];
}

export const GOOGLE_ENDPOINTS = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
} as const;

export function googleConfigFromEnv(): GoogleOAuthConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_CALLBACK_URL,
    ...GOOGLE_ENDPOINTS,
    issuers: [...GOOGLE_ENDPOINTS.issuers],
  };
}

export class OAuthFlowError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'OAuthFlowError';
  }
}

export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export function buildGoogleAuthorizationUrl(
  config: GoogleOAuthConfig,
  { state, nonce, codeVerifier }: { state: string; nonce: string; codeVerifier: string },
): string {
  const url = new URL(config.authorizationEndpoint);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: pkceChallenge(codeVerifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

function jwksFor(uri: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, jwks);
  }
  return jwks;
}

export async function exchangeGoogleCode(
  config: GoogleOAuthConfig,
  { code, codeVerifier, nonce }: { code: string; codeVerifier: string; nonce: string },
): Promise<GoogleIdentity> {
  let response: Response;
  try {
    response = await fetch(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new OAuthFlowError('token_exchange_failed');
  }
  if (!response.ok) throw new OAuthFlowError('token_exchange_failed');
  const tokens = (await response.json().catch(() => null)) as { id_token?: unknown } | null;
  if (!tokens || typeof tokens.id_token !== 'string') throw new OAuthFlowError('token_exchange_failed');

  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(tokens.id_token, jwksFor(config.jwksUri), {
      issuer: config.issuers,
      audience: config.clientId,
      algorithms: ['RS256'],
    });
    claims = verified.payload;
  } catch {
    throw new OAuthFlowError('invalid_id_token');
  }

  if (claims.nonce !== nonce) throw new OAuthFlowError('invalid_id_token');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new OAuthFlowError('invalid_id_token');
  if (typeof claims.email !== 'string' || claims.email_verified !== true) {
    throw new OAuthFlowError('email_not_verified');
  }

  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    name: typeof claims.name === 'string' ? claims.name : null,
    picture: typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture : null,
  };
}
