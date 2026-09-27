// Local stand-ins for Google (OIDC) and Slack (OAuth v2 + webhooks) that speak
// the real protocols, so the production OAuth code can be exercised end to end
// without browser consent screens. Google ID tokens are RS256-signed and
// verified by the app through the JWKS endpoint; the token endpoint enforces
// the client secret, redirect URI and PKCE verifier.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';

export interface GoogleIdentityClaims {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  emailVerified?: boolean;
}

interface GoogleCodeGrant {
  claims: GoogleIdentityClaims;
  nonce: string;
  codeChallenge: string;
  // Test knobs for negative cases.
  audience?: string;
  signWithForeignKey?: boolean;
}

export type HookMode = 'ok' | 'fail500' | 'rate_limited' | 'revoked';

export interface FakeOAuthServer {
  base: string;
  google: { clientId: string; clientSecret: string; redirectUri: string };
  slack: { clientId: string; clientSecret: string; redirectUri: string };
  issueGoogleCode(grant: GoogleCodeGrant): string;
  issueSlackCode(install: { teamId: string; teamName: string; channel: string; reuseToken?: string }): string;
  // Webhook messages received, per hook id.
  hookMessages: { hookId: string; body: any }[];
  // Every webhook request, successful or not.
  hookRequests: () => number;
  revokedTokens: Set<string>;
  tokenForHook: Map<string, string>;
  setHookMode(mode: HookMode): void;
  close(): Promise<void>;
}

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function startFakeOAuth(): Promise<FakeOAuthServer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  const google = { clientId: 'test-google-client-id', clientSecret: 'test-google-client-secret', redirectUri: 'http://app.test/auth/google/callback' };
  const slack = { clientId: 'test-slack-client-id', clientSecret: 'test-slack-client-secret', redirectUri: 'http://app.test/slack/callback' };

  const googleCodes = new Map<string, GoogleCodeGrant>();
  const slackCodes = new Map<string, { teamId: string; teamName: string; channel: string; reuseToken?: string }>();
  const hookMessages: { hookId: string; body: any }[] = [];
  const revokedTokens = new Set<string>();
  const tokenForHook = new Map<string, string>();
  let hookMode: HookMode = 'ok';
  let hookRequestCount = 0;
  let base = '';

  const sign = (key: CryptoKey, grant: GoogleCodeGrant) =>
    new SignJWT({
      email: grant.claims.email,
      email_verified: grant.claims.emailVerified ?? true,
      name: grant.claims.name,
      picture: grant.claims.picture,
      nonce: grant.nonce,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(base)
      .setAudience(grant.audience ?? google.clientId)
      .setSubject(grant.claims.sub)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const body = await readBody(req);
    const form = new URLSearchParams(body);

    if (req.method === 'GET' && url.pathname === '/google/jwks') return json(res, 200, { keys: [jwk] });

    if (req.method === 'POST' && url.pathname === '/google/token') {
      const grant = googleCodes.get(form.get('code') ?? '');
      googleCodes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (
        !grant ||
        form.get('grant_type') !== 'authorization_code' ||
        form.get('client_id') !== google.clientId ||
        form.get('client_secret') !== google.clientSecret ||
        form.get('redirect_uri') !== google.redirectUri ||
        challenge !== grant.codeChallenge
      ) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      const idToken = await sign(grant.signWithForeignKey ? foreign.privateKey : privateKey, grant);
      return json(res, 200, { access_token: 'ya29.fake-google-access-token', id_token: idToken, token_type: 'Bearer', expires_in: 3600 });
    }

    if (req.method === 'POST' && url.pathname === '/slack/api/oauth.v2.access') {
      const install = slackCodes.get(form.get('code') ?? '');
      slackCodes.delete(form.get('code') ?? '');
      if (
        !install ||
        form.get('client_id') !== slack.clientId ||
        form.get('client_secret') !== slack.clientSecret ||
        form.get('redirect_uri') !== slack.redirectUri
      ) {
        return json(res, 200, { ok: false, error: 'invalid_code' });
      }
      const token = install.reuseToken ?? `xoxb-test-${randomBytes(12).toString('hex')}`;
      const hookId = randomBytes(8).toString('hex');
      tokenForHook.set(hookId, token);
      return json(res, 200, {
        ok: true,
        access_token: token,
        token_type: 'bot',
        scope: 'incoming-webhook',
        bot_user_id: 'UBOT123',
        app_id: 'A123',
        team: { id: install.teamId, name: install.teamName },
        incoming_webhook: { channel: install.channel, channel_id: 'C123', configuration_url: `${base}/cfg`, url: `${base}/slack/hooks/${hookId}` },
      });
    }

    if (req.method === 'POST' && url.pathname === '/slack/api/auth.revoke') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!token || revokedTokens.has(token)) return json(res, 200, { ok: false, error: 'invalid_auth' });
      revokedTokens.add(token);
      return json(res, 200, { ok: true, revoked: true });
    }

    const hook = /^\/slack\/hooks\/([a-f0-9]+)$/.exec(url.pathname);
    if (req.method === 'POST' && hook) {
      hookRequestCount++;
      const hookId = hook[1]!;
      const token = tokenForHook.get(hookId);
      if (!token || revokedTokens.has(token) || hookMode === 'revoked') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('no_service');
      }
      if (hookMode === 'fail500') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end('internal_error');
      }
      if (hookMode === 'rate_limited') {
        res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '1' });
        return res.end('rate_limited');
      }
      hookMessages.push({ hookId, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }

    json(res, 404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    google,
    slack,
    issueGoogleCode(grant) {
      const code = randomBytes(16).toString('hex');
      googleCodes.set(code, grant);
      return code;
    },
    issueSlackCode(install) {
      const code = randomBytes(16).toString('hex');
      slackCodes.set(code, install);
      return code;
    },
    hookMessages,
    hookRequests: () => hookRequestCount,
    revokedTokens,
    tokenForHook,
    setHookMode(mode) {
      hookMode = mode;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
