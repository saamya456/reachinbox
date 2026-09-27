// Phase 5 integration tests: Google sign-in, sessions, tenant isolation,
// sender API + SSRF protection, Slack OAuth, token storage and hourly-limit
// notifications. Real PostgreSQL and Redis; Google and Slack are local servers
// speaking their protocols (tests/fixtures/fake-oauth.ts).
import './setup.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../src/app.js';
import { createSession, hashToken, SESSION_COOKIE } from '../src/auth/session.js';
import { emailEvents, emitHourlyLimitReached, type HourlyLimitReachedEvent } from '../src/events/email-events.js';
import { decryptSecret } from '../src/lib/crypto.js';
import { prisma } from '../src/lib/prisma.js';
import { getRedisConnection } from '../src/queue/connection.js';
import { emailJobId } from '../src/queue/email.queue.js';
import { scheduleEmail } from '../src/services/email-scheduler.service.js';
import { createSmtpDelivery } from '../src/services/smtp-delivery.service.js';
import {
  createSlackNotificationWorker,
  createSlackQueue,
  enqueueHourlyLimitNotification,
  processSlackNotification,
  subscribeHourlyLimitNotifications,
  type SlackJobData,
} from '../src/slack/slack-notifications.js';
import { startFakeOAuth, type FakeOAuthServer, type GoogleIdentityClaims } from './fixtures/fake-oauth.js';
import {
  cleanup,
  fakeDelivery,
  makeEmail,
  makeTenant,
  newLimiter,
  newQueue,
  newWorker,
  onCleanup,
  run,
  trackUser,
  waitForJobEnd,
  type Tenant,
} from './helpers.js';
import { TestClient } from './http-client.js';

let fake: FakeOAuthServer;
let base: string;
const WEBHOOK_HOSTS = ['127.0.0.1'];

before(async () => {
  fake = await startFakeOAuth();
  const app = createApp({
    google: {
      ...fake.google,
      authorizationEndpoint: `${fake.base}/google/authorize`,
      tokenEndpoint: `${fake.base}/google/token`,
      jwksUri: `${fake.base}/google/jwks`,
      issuers: [fake.base],
    },
    slack: {
      ...fake.slack,
      authorizeUrl: `${fake.base}/slack/authorize`,
      apiBaseUrl: `${fake.base}/slack/api`,
      webhookHosts: WEBHOOK_HOSTS,
    },
  });
  const server: http.Server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onCleanup(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fake.close();
  });
});

after(cleanup);

// --- helpers ---------------------------------------------------------------

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 15_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function identity(label: string): GoogleIdentityClaims {
  const id = randomUUID().slice(0, 8);
  return { sub: `sub-${run}-${label}-${id}`, email: `${label}-${id}@example.com`, name: `User ${label}`, picture: 'https://example.com/avatar.png' };
}

async function startGoogle(client: TestClient, returnTo?: string) {
  const start = await client.get(`/auth/google${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`);
  const url = new URL(start.location!);
  return {
    start,
    url,
    state: url.searchParams.get('state')!,
    nonce: url.searchParams.get('nonce')!,
    challenge: url.searchParams.get('code_challenge')!,
  };
}

async function googleLogin(client: TestClient, claims: GoogleIdentityClaims, returnTo?: string) {
  const flow = await startGoogle(client, returnTo);
  const code = fake.issueGoogleCode({ claims, nonce: flow.nonce, codeChallenge: flow.challenge });
  return client.get(`/auth/google/callback?code=${code}&state=${flow.state}`);
}

async function signedInUser(label: string) {
  const client = new TestClient(base);
  const claims = identity(label);
  const callback = await googleLogin(client, claims);
  assert.equal(callback.status, 302);
  const me = await client.get('/auth/me');
  assert.equal(me.status, 200, JSON.stringify(me.body));
  trackUser(me.body.id);
  return { client, user: me.body as { id: string; email: string; name: string; avatarUrl: string }, claims };
}

// A tenant from makeTenant plus a signed-in browser for it.
async function tenantWithSession(options: Parameters<typeof makeTenant>[0] = {}) {
  const t = await makeTenant(options);
  const client = new TestClient(base);
  client.cookies.set(SESSION_COOKIE, await createSession(t.user.id));
  return { t, client };
}

async function connectSlack(client: TestClient, install = { teamId: 'T123', teamName: 'Acme', channel: '#alerts' }) {
  const start = await client.get('/slack/connect');
  assert.equal(start.status, 302, JSON.stringify(start.body));
  const state = new URL(start.location!).searchParams.get('state')!;
  const code = fake.issueSlackCode(install);
  return client.get(`/slack/callback?code=${code}&state=${state}`);
}

const validSender = (overrides: Record<string, unknown> = {}) => ({
  email: `sender-${randomUUID().slice(0, 8)}@ethereal.email`,
  displayName: 'Sales',
  smtpHost: 'smtp.ethereal.email',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: 'user@ethereal.email',
  smtpPassword: 'super-secret-smtp-password',
  hourlyLimit: 50,
  ...overrides,
});

function slackHarness() {
  const prefix = `test-${run}-slack-${randomUUID().slice(0, 6)}`;
  const queue = createSlackQueue({ prefix });
  const worker = createSlackNotificationWorker({ prefix, webhookHosts: WEBHOOK_HOSTS });
  const unsubscribe = subscribeHourlyLimitNotifications(queue);
  onCleanup(async () => {
    unsubscribe();
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });
  return { queue, worker, unsubscribe };
}

function jobFor(t: Tenant, windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000)): SlackJobData {
  return {
    userId: t.user.id,
    senderId: t.sender.id,
    campaignId: t.campaign.id,
    scope: 'sender',
    windowStart: windowStart.toISOString(),
    nextSlotAt: new Date(windowStart.getTime() + 3_600_000).toISOString(),
  };
}

// --- AUTH ------------------------------------------------------------------

test('A1. /auth/google starts a real OIDC authorization request with state, nonce and PKCE', async () => {
  const client = new TestClient(base);
  const { start, url, state, nonce, challenge } = await startGoogle(client);

  assert.equal(start.status, 302);
  assert.equal(url.origin + url.pathname, `${fake.base}/google/authorize`);
  assert.equal(url.searchParams.get('client_id'), fake.google.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), fake.google.redirectUri);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(url.searchParams.get('client_secret'), null, 'secret never sent to the browser');
  const binding = start.setCookies.find((c) => c.startsWith('ri_oauth_google='))!;
  assert.match(binding, /HttpOnly/i);
  assert.match(binding, /SameSite=Lax/i);
});

test('A2. invalid, replayed or foreign-browser OAuth state is rejected and creates no session', async () => {
  const victim = new TestClient(base);
  const attacker = new TestClient(base);
  const claims = identity('attacker');

  // Tampered state.
  const flow = await startGoogle(victim);
  const code = fake.issueGoogleCode({ claims, nonce: flow.nonce, codeChallenge: flow.challenge });
  const tampered = await victim.get(`/auth/google/callback?code=${code}&state=${'x'.repeat(43)}`);
  assert.equal(tampered.location, 'http://localhost:5173/login?error=invalid_state');
  assert.equal(victim.cookies.has(SESSION_COOKIE), false);

  // Login CSRF: attacker's own flow, callback URL opened in the victim's browser.
  const attackerFlow = await startGoogle(attacker);
  const attackerCode = fake.issueGoogleCode({ claims, nonce: attackerFlow.nonce, codeChallenge: attackerFlow.challenge });
  const csrf = await victim.get(`/auth/google/callback?code=${attackerCode}&state=${attackerFlow.state}`);
  assert.equal(csrf.location, 'http://localhost:5173/login?error=invalid_state');
  assert.equal((await victim.get('/auth/me')).status, 401);

  // Replay: the (now consumed) state cannot be used again, even by its owner.
  const replay = await attacker.get(`/auth/google/callback?code=${attackerCode}&state=${attackerFlow.state}`);
  assert.equal(replay.location, 'http://localhost:5173/login?error=invalid_state');
  assert.equal(await prisma.user.count({ where: { googleId: claims.sub } }), 0);
});

test('A3. successful callback creates the user and an HttpOnly session; Redis stores only a hash', async () => {
  const client = new TestClient(base);
  const claims = identity('a3');
  const callback = await googleLogin(client, claims, '/dashboard');

  assert.equal(callback.status, 302);
  assert.equal(callback.location, 'http://localhost:5173/dashboard');
  const cookie = callback.setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\//);
  const sessionId = client.cookies.get(SESSION_COOKIE)!;
  const redis = getRedisConnection();
  assert.equal(await redis.exists(`sess:${sessionId}`), 0, 'raw session id is not a key');
  assert.equal(await redis.exists(`sess:${hashToken(sessionId)}`), 1);

  const user = await prisma.user.findUniqueOrThrow({ where: { googleId: claims.sub } });
  trackUser(user.id);
  assert.equal(user.email, claims.email);
  assert.equal(user.name, claims.name);
  assert.equal(user.avatarUrl, claims.picture);
  assert.equal(client.cookies.has('ri_oauth_google'), false, 'binding cookie cleared');
});

test('A4. /auth/me returns only safe user fields', async () => {
  const { client, user, claims } = await signedInUser('a4');
  const me = await client.get('/auth/me');
  assert.deepEqual(Object.keys(me.body).sort(), ['avatarUrl', 'email', 'id', 'isAdmin', 'name']);
  assert.equal(me.body.isAdmin, false);
  assert.equal(user.email, claims.email);
  assert.doesNotMatch(me.text, /google|token|secret|password/i);
});

test('A5. protected routes return 401 without a session', async () => {
  const anon = new TestClient(base);
  for (const path of ['/auth/me', '/api/senders', '/api/campaigns', `/api/emails/${randomUUID()}`, '/slack/status', '/slack/connect']) {
    const res = await anon.get(path);
    assert.equal(res.status, 401, path);
    assert.equal(res.body.error.code, 'unauthenticated');
  }
  assert.equal((await anon.post('/api/senders', validSender())).status, 401);
  assert.equal((await anon.post('/slack/disconnect')).status, 401);
});

test('A6. logout invalidates the session server-side (old cookie no longer works)', async () => {
  const { client } = await signedInUser('a6');
  const stolenCopy = client.cookies.get(SESSION_COOKIE)!;

  const logout = await client.post('/auth/logout');
  assert.equal(logout.status, 204);
  assert.equal(client.cookies.has(SESSION_COOKIE), false, 'cookie cleared');
  assert.equal((await client.get('/auth/me')).status, 401);

  const replay = new TestClient(base);
  replay.cookies.set(SESSION_COOKIE, stolenCopy);
  assert.equal((await replay.get('/auth/me')).status, 401);
  assert.equal((await replay.get('/api/senders')).status, 401);
});

test('A7. forged or unverified ID tokens are rejected', async () => {
  const cases = [
    { grant: { signWithForeignKey: true }, error: 'invalid_id_token' },
    { grant: { audience: 'someone-elses-client-id' }, error: 'invalid_id_token' },
    { grant: { nonceOverride: true }, error: 'invalid_id_token' },
    { grant: { unverified: true }, error: 'email_not_verified' },
  ];
  for (const c of cases) {
    const client = new TestClient(base);
    const claims = { ...identity('a7'), emailVerified: !('unverified' in c.grant) };
    const flow = await startGoogle(client);
    const code = fake.issueGoogleCode({
      claims,
      nonce: 'nonceOverride' in c.grant ? 'not-the-nonce' : flow.nonce,
      codeChallenge: flow.challenge,
      ...('signWithForeignKey' in c.grant ? { signWithForeignKey: true } : {}),
      ...('audience' in c.grant ? { audience: c.grant.audience } : {}),
    });
    const res = await client.get(`/auth/google/callback?code=${code}&state=${flow.state}`);
    assert.equal(res.location, `http://localhost:5173/login?error=${c.error}`, JSON.stringify(c.grant));
    assert.equal(client.cookies.has(SESSION_COOKIE), false);
    assert.equal(await prisma.user.count({ where: { googleId: claims.sub } }), 0);
  }
});

test('A8. post-login redirects never leave the frontend (no open redirect)', async () => {
  for (const returnTo of ['https://evil.example/phish', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
    const client = new TestClient(base);
    const claims = identity('a8');
    const res = await googleLogin(client, claims, returnTo);
    assert.equal(res.location, 'http://localhost:5173/', returnTo);
    trackUser((await prisma.user.findUniqueOrThrow({ where: { googleId: claims.sub } })).id);
  }
});

test('A9. state-changing requests from a foreign Origin are rejected', async () => {
  const { client } = await signedInUser('a9');
  const res = await client.post('/api/senders', validSender(), { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  const ok = await client.post('/auth/logout', undefined, { origin: 'http://localhost:5173' });
  assert.equal(ok.status, 204);
});

test('A10. OAuth routes answer 503 when the provider is not configured', async () => {
  const app = createApp({ google: null, slack: null });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = new TestClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    assert.equal((await client.get('/auth/google')).status, 503);
    const t = await makeTenant();
    client.cookies.set(SESSION_COOKIE, await createSession(t.user.id));
    assert.equal((await client.get('/slack/connect')).status, 503);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

// --- TENANT ISOLATION ------------------------------------------------------

test('T7+T8. user A cannot read, update or delete user B\'s sender', async () => {
  const a = await signedInUser('t7a');
  const b = await signedInUser('t7b');
  const created = await b.client.post('/api/senders', validSender());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const bSender = created.body.id;

  assert.equal((await a.client.get(`/api/senders/${bSender}`)).status, 404);
  assert.equal((await a.client.patch(`/api/senders/${bSender}`, { hourlyLimit: 1 })).status, 404);
  assert.equal((await a.client.patch(`/api/senders/${bSender}`, { isActive: false })).status, 404);
  assert.equal((await a.client.delete(`/api/senders/${bSender}`)).status, 404);
  assert.deepEqual((await a.client.get('/api/senders')).body, []);

  const untouched = await prisma.sender.findUniqueOrThrow({ where: { id: bSender } });
  assert.equal(untouched.hourlyLimit, 50);
  assert.equal(untouched.isActive, true);
});

test('T9. user A cannot access user B\'s campaigns or emails', async () => {
  const { t: bTenant } = await tenantWithSession();
  const a = await tenantWithSession();
  const bEmail = await makeEmail(bTenant, new Date());
  const aEmail = await makeEmail(a.t, new Date());

  assert.equal((await a.client.get(`/api/campaigns/${bTenant.campaign.id}`)).status, 404);
  assert.equal((await a.client.get(`/api/emails/${bEmail.id}`)).status, 404);
  const list = await a.client.get('/api/campaigns');
  assert.deepEqual(list.body.map((c: { id: string }) => c.id), [a.t.campaign.id]);
  assert.equal((await a.client.get(`/api/campaigns/${a.t.campaign.id}`)).status, 200);
  const own = await a.client.get(`/api/emails/${aEmail.id}`);
  assert.equal(own.status, 200);
  assert.equal(own.body.id, aEmail.id);
});

test('T10. a client-supplied userId cannot override the session identity', async () => {
  const a = await signedInUser('t10a');
  const b = await signedInUser('t10b');
  const res = await a.client.post('/api/senders', { ...validSender(), userId: b.user.id });
  assert.equal(res.status, 400, 'unknown fields are rejected');
  assert.equal(await prisma.sender.count({ where: { userId: b.user.id } }), 0);
  const patch = await a.client.post('/api/senders', validSender());
  const moved = await a.client.patch(`/api/senders/${patch.body.id}`, { userId: b.user.id });
  assert.equal(moved.status, 400);
  assert.equal((await prisma.sender.findUniqueOrThrow({ where: { id: patch.body.id } })).userId, a.user.id);
});

// --- SENDERS ---------------------------------------------------------------

test('S11–S15. create, list, update, deactivate/delete senders; the password is never returned', async () => {
  const { client, user } = await signedInUser('s11');
  const input = validSender();
  const responses: string[] = [];

  const created = await client.post('/api/senders', input);
  responses.push(created.text);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.email, input.email);
  assert.equal(created.body.smtpHost, 'smtp.ethereal.email');
  assert.equal(created.body.hourlyLimit, 50);
  const row = await prisma.sender.findUniqueOrThrow({ where: { id: created.body.id } });
  assert.equal(row.userId, user.id);
  assert.notEqual(row.smtpPasswordEncrypted, input.smtpPassword);
  assert.equal(decryptSecret(row.smtpPasswordEncrypted), input.smtpPassword);

  const list = await client.get('/api/senders');
  responses.push(list.text);
  assert.deepEqual(list.body.map((s: { id: string }) => s.id), [created.body.id]);
  responses.push((await client.get(`/api/senders/${created.body.id}`)).text);

  const updated = await client.patch(`/api/senders/${created.body.id}`, { hourlyLimit: 75, smtpPassword: 'rotated-password' });
  responses.push(updated.text);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.hourlyLimit, 75);
  const rotated = await prisma.sender.findUniqueOrThrow({ where: { id: created.body.id } });
  assert.equal(decryptSecret(rotated.smtpPasswordEncrypted), 'rotated-password');

  const duplicate = await client.post('/api/senders', { ...validSender(), email: input.email });
  assert.equal(duplicate.status, 409);

  // With email history -> deactivated; without -> deleted.
  const campaign = await prisma.campaign.create({
    data: { userId: user.id, subject: 'S', body: 'B', startAt: new Date(), delayBetweenEmailsMs: 0, hourlyLimit: 10 },
  });
  await prisma.email.create({
    data: {
      userId: user.id, campaignId: campaign.id, senderId: created.body.id, recipientEmail: 'r@example.com',
      subject: 'S', body: 'B', scheduledAt: new Date(), originalScheduledAt: new Date(), idempotencyKey: randomUUID(),
    },
  });
  const deactivated = await client.delete(`/api/senders/${created.body.id}`);
  responses.push(deactivated.text);
  assert.equal(deactivated.body.outcome, 'deactivated');
  assert.equal(deactivated.body.sender.isActive, false);

  const spare = await client.post('/api/senders', validSender());
  const deleted = await client.delete(`/api/senders/${spare.body.id}`);
  assert.deepEqual(deleted.body, { outcome: 'deleted', id: spare.body.id });
  assert.equal(await prisma.sender.count({ where: { id: spare.body.id } }), 0);

  for (const text of responses) {
    assert.doesNotMatch(text, /smtpPassword|super-secret-smtp-password|rotated-password|v1:/);
  }
});

test('S16. unsafe SMTP hosts and ports are rejected server-side (SSRF)', async () => {
  const { client } = await signedInUser('s16');
  const unsafe = [
    { smtpHost: 'localhost' },
    { smtpHost: '127.0.0.1' },
    { smtpHost: '10.0.0.5' },
    { smtpHost: '172.17.0.2' },
    { smtpHost: '192.168.1.10' },
    { smtpHost: '169.254.169.254' },
    { smtpHost: 'metadata.google.internal' },
    { smtpHost: '::1' },
    { smtpHost: 'fd00:ec2::254' },
    { smtpHost: 'redis' },
    { smtpHost: 'postgres' },
    { smtpHost: 'localtest.me' }, // public DNS name that resolves to 127.0.0.1
    { smtpHost: 'http://smtp.ethereal.email' },
    { smtpHost: 'no-such-host-zz9.example' },
    { smtpPort: 6379 },
    { smtpPort: 5432 },
  ];
  for (const override of unsafe) {
    const res = await client.post('/api/senders', validSender(override));
    assert.equal(res.status, 400, JSON.stringify(override));
  }
  const ok = await client.post('/api/senders', validSender());
  assert.equal(ok.status, 201);
  const patch = await client.patch(`/api/senders/${ok.body.id}`, { smtpHost: '192.168.0.1' });
  assert.equal(patch.status, 400);
  assert.equal((await prisma.sender.findUniqueOrThrow({ where: { id: ok.body.id } })).smtpHost, 'smtp.ethereal.email');
  assert.equal('userId' in ok.body, false, 'owner id is not part of the public sender');
});

test('S17. delivery re-checks the host: a stored internal host is blocked before any connection', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant({ smtp: { host: 'localtest.me', port: 587, user: 'u', password: 'p', email: 'sender@x.test' } });
  const email = await makeEmail(t, new Date(Date.now() - 1_000));
  const { jobId } = await scheduleEmail(email.id, queue);
  const worker = newWorker(prefix, createSmtpDelivery());
  const end = await waitForJobEnd(worker, jobId, 20_000);
  assert.equal(end.state, 'failed');
  const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, 'FAILED');
  assert.equal(row.errorCode, 'SMTP_HOST_BLOCKED');
});

test('S18. POST /api/senders/ethereal creates a real Ethereal sender for the session user', async () => {
  const { client, user } = await signedInUser('s18');
  const res = await client.post('/api/senders/ethereal', { hourlyLimit: 20 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.match(res.body.email, /@ethereal\.email$/);
  assert.equal(res.body.smtpHost, 'smtp.ethereal.email');
  assert.doesNotMatch(res.text, /password/i);
  assert.equal((await prisma.sender.findUniqueOrThrow({ where: { id: res.body.id } })).userId, user.id);
  // A second one in the same process gets a NEW account (no process-wide cache).
  const second = await client.post('/api/senders/ethereal', { hourlyLimit: 20 });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.notEqual(second.body.email, res.body.email);
});

// --- SLACK -----------------------------------------------------------------

test('K17. Slack OAuth state is validated and bound to the initiating user and session', async () => {
  const a = await tenantWithSession();
  const b = await tenantWithSession();

  const bad = await a.client.get(`/slack/callback?code=${fake.issueSlackCode({ teamId: 'T1', teamName: 'X', channel: '#x' })}&state=${'y'.repeat(43)}`);
  assert.match(bad.location!, /slack=invalid_state/);

  // A's flow completed in B's session must not attach to either tenant.
  const start = await a.client.get('/slack/connect');
  const state = new URL(start.location!).searchParams.get('state')!;
  const code = fake.issueSlackCode({ teamId: 'T1', teamName: 'X', channel: '#x' });
  const crossed = await b.client.get(`/slack/callback?code=${code}&state=${state}`);
  assert.match(crossed.location!, /slack=invalid_state/);

  // Same user, different session (e.g. stolen callback URL) is rejected too.
  const other = new TestClient(base);
  other.cookies.set(SESSION_COOKIE, await createSession(a.t.user.id));
  const start2 = await a.client.get('/slack/connect');
  const state2 = new URL(start2.location!).searchParams.get('state')!;
  const crossedSession = await other.get(`/slack/callback?code=${fake.issueSlackCode({ teamId: 'T1', teamName: 'X', channel: '#x' })}&state=${state2}`);
  assert.match(crossedSession.location!, /slack=invalid_state/);

  assert.equal(await prisma.slackConnection.count({ where: { userId: { in: [a.t.user.id, b.t.user.id] } } }), 0);
  const authorize = new URL(start.location!);
  assert.equal(authorize.searchParams.get('scope'), 'incoming-webhook');
  assert.equal(authorize.searchParams.get('client_secret'), null);
});

test('K18–K20. connect stores the token and webhook encrypted; status never returns secrets', async () => {
  const { t, client } = await tenantWithSession();
  assert.deepEqual((await client.get('/slack/status')).body, { status: 'disconnected', configured: true });

  const callback = await connectSlack(client);
  assert.equal(callback.location, 'http://localhost:5173/?slack=connected');

  const row = await prisma.slackConnection.findFirstOrThrow({ where: { userId: t.user.id } });
  const token = decryptSecret(row.accessTokenEncrypted);
  const webhook = decryptSecret(row.webhookUrlEncrypted!);
  assert.match(token, /^xoxb-test-/);
  assert.notEqual(row.accessTokenEncrypted, token);
  assert.match(webhook, /\/slack\/hooks\//);
  assert.notEqual(row.webhookUrlEncrypted, webhook);

  const status = await client.get('/slack/status');
  assert.equal(status.body.status, 'connected');
  assert.equal(status.body.teamName, 'Acme');
  assert.equal(status.body.channelName, '#alerts');
  assert.ok(!status.text.includes(token) && !status.text.includes(webhook));
  assert.doesNotMatch(status.text, /xoxb|hooks|token|Encrypted/i);
});

test('K21–K22. disconnect revokes and deletes credentials; reconnect works', async () => {
  const { t, client } = await tenantWithSession();
  await connectSlack(client);
  const row = await prisma.slackConnection.findFirstOrThrow({ where: { userId: t.user.id } });
  const oldToken = decryptSecret(row.accessTokenEncrypted);

  const disconnect = await client.post('/slack/disconnect');
  assert.deepEqual(disconnect.body, { status: 'disconnected', revoked: true });
  assert.ok(fake.revokedTokens.has(oldToken), 'token revoked at Slack');
  assert.equal(await prisma.slackConnection.count({ where: { userId: t.user.id } }), 0);
  assert.equal((await client.get('/slack/status')).body.status, 'disconnected');

  // No notification can use the old credentials.
  const before = fake.hookRequests();
  assert.deepEqual(await processSlackNotification(jobFor(t), { webhookHosts: WEBHOOK_HOSTS }), {
    outcome: 'skipped',
    reason: 'no_active_connection',
  });
  assert.equal(fake.hookRequests(), before);

  const again = await connectSlack(client, { teamId: 'T123', teamName: 'Acme', channel: '#ops' });
  assert.match(again.location!, /slack=connected/);
  const status = await client.get('/slack/status');
  assert.equal(status.body.status, 'connected');
  assert.equal(status.body.channelName, '#ops');
  const newRow = await prisma.slackConnection.findFirstOrThrow({ where: { userId: t.user.id } });
  assert.notEqual(decryptSecret(newRow.accessTokenEncrypted), oldToken);
});

test('K23. a revoked Slack token marks the connection REVOKED and is not retried', async () => {
  const { t, client } = await tenantWithSession();
  await connectSlack(client);
  fake.setHookMode('revoked');
  try {
    const result = await processSlackNotification(jobFor(t), { webhookHosts: WEBHOOK_HOSTS });
    assert.equal(result.outcome, 'connection_disabled');
    const status = await client.get('/slack/status');
    assert.equal(status.body.status, 'revoked');
    assert.equal(status.body.lastError, 'no_service');

    const before = fake.hookRequests();
    const again = await processSlackNotification(jobFor(t), { webhookHosts: WEBHOOK_HOSTS });
    assert.deepEqual(again, { outcome: 'skipped', reason: 'no_active_connection' });
    assert.equal(fake.hookRequests(), before, 'known-invalid credentials are not used again');
  } finally {
    fake.setHookMode('ok');
  }
  // Reconnecting restores notifications.
  await connectSlack(client);
  assert.equal((await client.get('/slack/status')).body.status, 'connected');
});

test('K24–K25. reaching the hourly limit sends exactly one real Slack message per window', async () => {
  const { t, client } = await tenantWithSession({ senderHourlyLimit: 1 });
  await connectSlack(client);
  const { queue } = slackHarness();
  const messagesBefore = fake.hookMessages.length;

  const { queue: emailQueue, prefix } = newQueue();
  const emails = await Promise.all([0, 1, 2].map((i) => makeEmail(t, new Date(Date.now() - 3_000 + i))));
  for (const e of emails) await scheduleEmail(e.id, emailQueue);
  const delivery = fakeDelivery();
  newWorker(prefix, delivery.service, { concurrency: 1, rateLimiter: newLimiter() });

  await waitUntil(() => fake.hookMessages.length > messagesBefore, 20_000, 'slack message');
  await waitUntil(async () => (await prisma.email.count({ where: { userId: t.user.id, rescheduleCount: 1 } })) === 2, 10_000, 'two rescheduled');
  assert.equal(delivery.calls.length, 1, 'limit 1: one email sent');

  // Duplicate event for the same window: no second message.
  const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const event: HourlyLimitReachedEvent = {
    userId: t.user.id, senderId: t.sender.id, campaignId: t.campaign.id, emailId: emails[2]!.id,
    scope: 'sender', windowStart, nextSlotAt: new Date(windowStart.getTime() + 3_600_000),
  };
  emitHourlyLimitReached(event);
  await enqueueHourlyLimitNotification(queue, event);
  await sleep(1_000);

  const ours = fake.hookMessages.slice(messagesBefore);
  assert.equal(ours.length, 1, 'exactly one Slack message');
  const text = ours[0]!.body.blocks[0].text.text as string;
  assert.match(text, /Hourly sending limit reached/);
  assert.match(text, new RegExp(t.sender.email.replace(/[.]/g, '\\.')));
  assert.match(text, /limit 1\/hour/);
  assert.match(text, /Next sending slot/);
  assert.doesNotMatch(JSON.stringify(ours[0]!.body), /xoxb|password|secret/i);
  const counts = await queue.getJobCounts('completed', 'waiting', 'delayed', 'failed');
  assert.equal(counts.completed, 1);
  assert.equal((await client.get('/slack/status')).body.lastNotifiedAt !== null, true);
});

test('K26. Slack failures (5xx, throwing subscriber) never affect email delivery', async () => {
  const { t, client } = await tenantWithSession({ senderHourlyLimit: 1 });
  await connectSlack(client);
  const throwing = () => {
    throw new Error('subscriber exploded');
  };
  // Registered BEFORE the Slack subscriber: it must not stop Slack from being notified.
  emailEvents.on('hourlyLimitReached', throwing);
  const { queue } = slackHarness();
  fake.setHookMode('fail500');
  try {
    const { queue: emailQueue, prefix } = newQueue();
    const emails = await Promise.all([0, 1].map((i) => makeEmail(t, new Date(Date.now() - 3_000 + i))));
    for (const e of emails) await scheduleEmail(e.id, emailQueue);
    const delivery = fakeDelivery();
    const worker = newWorker(prefix, delivery.service, { concurrency: 1, rateLimiter: newLimiter() });

    const first = await waitForJobEnd(worker, emailJobId(emails[0]!.id));
    assert.equal(first.state, 'completed');
    await waitUntil(async () => (await prisma.email.count({ where: { userId: t.user.id, rescheduleCount: 1 } })) === 1, 10_000, 'rescheduled');
    await waitUntil(async () => (await queue.getJobCounts('delayed', 'failed')).delayed === 1, 10_000, 'slack job retrying');

    const rows = await prisma.email.findMany({ where: { userId: t.user.id }, orderBy: { scheduledAt: 'asc' } });
    assert.deepEqual(rows.map((r) => r.status), ['SENT', 'SCHEDULED'], 'no email failed');
    assert.equal((await client.get('/slack/status')).body.status, 'connected', 'transient errors keep the connection');

    // The worker keeps processing other emails normally.
    const t2 = await makeTenant();
    const later = await makeEmail(t2, new Date(Date.now() - 1_000));
    await scheduleEmail(later.id, emailQueue);
    assert.equal((await waitForJobEnd(worker, emailJobId(later.id))).state, 'completed');
  } finally {
    emailEvents.off('hourlyLimitReached', throwing);
    fake.setHookMode('ok');
  }
});

test('K27. Slack job data contains ids only (no tokens or webhook URLs)', async () => {
  const { t, client } = await tenantWithSession();
  await connectSlack(client);
  const { queue } = slackHarness();
  const job = jobFor(t);
  await enqueueHourlyLimitNotification(queue, {
    userId: job.userId, senderId: job.senderId, campaignId: job.campaignId, emailId: randomUUID(),
    scope: 'sender', windowStart: new Date(job.windowStart), nextSlotAt: new Date(job.nextSlotAt),
  });
  const [stored] = await queue.getJobs(['waiting', 'active', 'completed', 'delayed']);
  assert.deepEqual(Object.keys(stored!.data).sort(), ['campaignId', 'nextSlotAt', 'scope', 'senderId', 'userId', 'windowStart']);
  const raw = await getRedisConnection().hget(`${queue.opts.prefix}:${queue.name}:${stored!.id}`, 'data');
  assert.doesNotMatch(raw ?? '', /xoxb|hooks|v1:/);
});
