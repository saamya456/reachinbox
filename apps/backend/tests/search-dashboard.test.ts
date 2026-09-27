// Phase 6 integration tests: Elasticsearch indexing (outbox triggers -> relay
// -> BullMQ -> bulk API), tenant-scoped search, consistency under failures,
// and the Bull Board dashboard. Real PostgreSQL, Redis and Elasticsearch;
// the outage test pauses the Elasticsearch container.
import './setup.js';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Client } from '@elastic/elasticsearch';
import { createApp } from '../src/app.js';
import { createSession, SESSION_COOKIE } from '../src/auth/session.js';
import { prisma } from '../src/lib/prisma.js';
import { getRedisConnection } from '../src/queue/connection.js';
import { emailJobId, type EmailQueue } from '../src/queue/email.queue.js';
import { scheduleEmail } from '../src/services/email-scheduler.service.js';
import {
  bulkApply,
  createElasticsearchClient,
  EMAIL_INDEX_PROPERTIES,
  ensureEmailIndex,
  physicalIndexName,
  toEmailDocument,
  emailDocumentSelect,
} from '../src/search/elasticsearch.js';
import { startOutboxRelay, type OutboxRelay } from '../src/search/outbox-relay.js';
import { reindexEmails } from '../src/search/reindex.js';
import {
  applyOutboxRows,
  createSearchIndexQueue,
  createSearchIndexWorker,
  enqueueOutboxBatch,
  type SearchIndexQueue,
} from '../src/search/search-index.queue.js';
import { createSlackQueue, enqueueHourlyLimitNotification, type SlackQueue } from '../src/slack/slack-notifications.js';
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
  waitForJobEnd,
  type Tenant,
} from './helpers.js';
import { TestClient } from './http-client.js';

const INDEX = `test-${run}-emails`;
const ADMIN_EMAIL = `admin-${run}@example.com`;
let es: Client;
let base: string;
let searchQueue: SearchIndexQueue;
let slackQueue: SlackQueue;
let emailQueue: EmailQueue;
let emailPrefix: string;
let relay: OutboxRelay;

before(async () => {
  es = createElasticsearchClient({ requestTimeoutMs: 3_000 });
  await ensureEmailIndex(es, INDEX);
  const qprefix = `test-${run}-search`;
  searchQueue = createSearchIndexQueue({ prefix: qprefix, attempts: 40, backoffMs: 200 });
  const searchWorker = createSearchIndexWorker({ prefix: qprefix, client: es, index: INDEX });
  relay = await startOutboxRelay({ queue: searchQueue });
  slackQueue = createSlackQueue({ prefix: qprefix });
  ({ queue: emailQueue, prefix: emailPrefix } = newQueue());

  const app = createApp({
    google: null,
    slack: null,
    elasticsearch: es,
    searchIndex: INDEX,
    dashboardQueues: [emailQueue, slackQueue, searchQueue],
    adminEmails: [ADMIN_EMAIL],
    emailQueue,
  });
  const server: http.Server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  onCleanup(async () => {
    unpauseElasticsearch();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await relay.stop();
    await searchWorker.close();
    for (const q of [searchQueue, slackQueue]) {
      await q.obliterate({ force: true });
      await q.close();
    }
    await es.indices.delete({ index: physicalIndexName(INDEX) }, { ignore: [404] });
    await es.close();
  });
});

after(cleanup);

// --- helpers ---------------------------------------------------------------

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 20_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function signIn(t: Tenant) {
  const client = new TestClient(base);
  client.cookies.set(SESSION_COOKIE, await createSession(t.user.id));
  return client;
}

const docCount = async (query: object) =>
  (await es.count({ index: INDEX, query: query as never })).count;

async function waitIndexed(userId: string, expected: number, timeoutMs = 20_000) {
  await waitUntil(async () => {
    await es.indices.refresh({ index: INDEX });
    return (await docCount({ term: { userId } })) === expected;
  }, timeoutMs, `${expected} documents for user`);
}

function pauseElasticsearch() {
  execFileSync('docker', ['pause', 'reachinbox-elasticsearch']);
}
function unpauseElasticsearch() {
  try {
    execFileSync('docker', ['unpause', 'reachinbox-elasticsearch'], { stdio: 'ignore' });
  } catch {
    // not paused
  }
}

// A tenant with a varied mailbox for search tests.
let seeded: { t: Tenant; client: TestClient; emails: Awaited<ReturnType<typeof makeEmail>>[] } | undefined;
async function seededTenant() {
  if (seeded) return seeded;
  const t = await makeTenant();
  const now = Date.now();
  const rows = [
    { recipientEmail: 'alice@acme.io', subject: 'Quarterly report for Acme', body: 'Numbers attached', status: 'SENT', min: -300 },
    { recipientEmail: 'bob@globex.com', subject: 'Welcome aboard', body: 'We are thrilled about the partnership', status: 'SENT', min: -200 },
    { recipientEmail: 'carol@initech.org', subject: 'Invoice 42', body: 'Please find the invoice', status: 'SCHEDULED', min: 60 },
    { recipientEmail: 'dave@globex.com', subject: 'Follow up', body: 'Just checking in', status: 'SCHEDULED', min: 120 },
    { recipientEmail: 'erin@acme.io', subject: 'Product launch', body: 'Launch date is set', status: 'SCHEDULED', min: 30 },
    { recipientEmail: 'frank@umbrella.net', subject: 'Contract renewal', body: 'Renewal terms inside', status: 'SENT', min: -100 },
    { recipientEmail: 'grace@hooli.com', subject: 'Meeting notes', body: 'Summary of the quarterly sync', status: 'FAILED', min: -50 },
  ] as const;
  const emails = [];
  for (const r of rows) {
    const at = new Date(now + r.min * 60_000);
    emails.push(
      await makeEmail(t, at, {
        recipientEmail: r.recipientEmail,
        subject: r.subject,
        body: r.body,
        status: r.status,
        ...(r.status === 'SENT' ? { sentAt: new Date(at.getTime() + 1_000) } : {}),
      }),
    );
  }
  await waitIndexed(t.user.id, emails.length);
  seeded = { t, client: await signIn(t), emails };
  return seeded;
}

async function search(client: TestClient, params: Record<string, string | number>) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  return client.get(`/api/emails/search?${qs}`);
}

// --- INDEX -----------------------------------------------------------------

test('X1. the index exists with the explicit mapping; ensure is idempotent and keeps documents', async () => {
  const aliases = await es.indices.getAlias({ name: INDEX });
  assert.deepEqual(Object.keys(aliases), [physicalIndexName(INDEX)]);
  const mapping = (await es.indices.getMapping({ index: INDEX }))[physicalIndexName(INDEX)]!.mappings;
  assert.equal(mapping.dynamic, 'strict');
  for (const [field, expected] of Object.entries(EMAIL_INDEX_PROPERTIES)) {
    assert.equal((mapping.properties as Record<string, { type?: string }>)[field]?.type, (expected as { type?: string }).type, field);
  }
  assert.equal((mapping.properties!.recipientEmail as { analyzer?: string }).analyzer, 'email_parts');

  const t = await makeTenant();
  const email = await makeEmail(t, new Date());
  await waitIndexed(t.user.id, 1);
  assert.equal(await ensureEmailIndex(es, INDEX), 'exists');
  await es.indices.refresh({ index: INDEX });
  assert.equal(await docCount({ term: { emailId: email.id } }), 1, 'documents survive ensure');
});

test('X2+X4. a scheduled email is indexed with document id = email id', async () => {
  const t = await makeTenant();
  const email = await makeEmail(t, new Date(Date.now() + 3_600_000), { recipientEmail: 'x2@example.com', subject: 'Scheduled x2' });
  await waitIndexed(t.user.id, 1);
  const doc = await es.get<{ emailId: string; status: string; userId: string; subject: string }>({ index: INDEX, id: email.id });
  assert.equal(doc._id, email.id);
  assert.equal(doc._source!.emailId, email.id);
  assert.equal(doc._source!.status, 'SCHEDULED');
  assert.equal(doc._source!.userId, t.user.id);
  assert.equal(doc._source!.subject, 'Scheduled x2');
});

test('X3+C21. sending updates the same document to SENT with sentAt (eventually)', async () => {
  const t = await makeTenant();
  const email = await makeEmail(t, new Date(Date.now() - 1_000), { subject: 'Will be sent' });
  await waitIndexed(t.user.id, 1);
  await scheduleEmail(email.id, emailQueue);
  const worker = newWorker(emailPrefix, fakeDelivery().service, { rateLimiter: newLimiter() });
  assert.equal((await waitForJobEnd(worker, emailJobId(email.id))).state, 'completed');

  await waitUntil(async () => {
    const doc = await es.get<{ status: string; sentAt: string | null }>({ index: INDEX, id: email.id });
    return doc._source!.status === 'SENT' && !!doc._source!.sentAt;
  }, 20_000, 'SENT in index');
  const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  const doc = await es.get<{ sentAt: string; subject: string; recipientEmail: string; searchVersion: number }>({ index: INDEX, id: email.id });
  assert.equal(doc._source!.sentAt, row.sentAt!.toISOString());
  assert.equal(doc._source!.subject, 'Will be sent');
  assert.equal(doc._source!.recipientEmail, row.recipientEmail);
  assert.equal(doc._source!.searchVersion, Number(row.searchVersion));
  await es.indices.refresh({ index: INDEX });
  assert.equal(await docCount({ term: { emailId: email.id } }), 1, 'no duplicate document');
});

test('X5. reindex from PostgreSQL is idempotent', async () => {
  const t = await makeTenant();
  for (let i = 0; i < 5; i++) await makeEmail(t, new Date(), { subject: `reindex ${i}` });
  await waitIndexed(t.user.id, 5);
  const first = await reindexEmails({ client: es, index: INDEX, userId: t.user.id });
  const second = await reindexEmails({ client: es, index: INDEX, userId: t.user.id });
  assert.deepEqual([first.indexed, first.failed.length, second.indexed, second.failed.length], [5, 0, 5, 0]);
  await es.indices.refresh({ index: INDEX });
  assert.equal(await docCount({ term: { userId: t.user.id } }), 5);
});

test('X6. repeated and out-of-order indexing never duplicates or regresses a document', async () => {
  const t = await makeTenant();
  const email = await makeEmail(t, new Date(), { subject: 'Version one' });
  await waitIndexed(t.user.id, 1);
  await prisma.email.update({ where: { id: email.id }, data: { subject: 'Version two' } });
  const latest = await prisma.email.findUniqueOrThrow({ where: { id: email.id }, select: emailDocumentSelect });
  await waitUntil(async () => (await es.get<{ subject: string }>({ index: INDEX, id: email.id }))._source!.subject === 'Version two');

  // Same operation three times: applied, no duplicates.
  for (let i = 0; i < 3; i++) {
    const r = await bulkApply(es, INDEX, [{ kind: 'index', emailId: email.id, version: latest.searchVersion, document: toEmailDocument(latest) }]);
    assert.deepEqual(r.failed, []);
  }
  // A stale (older-version) document is ignored, not applied.
  const stale = { ...latest, subject: 'Version one', searchVersion: latest.searchVersion - 1n };
  const r = await bulkApply(es, INDEX, [{ kind: 'index', emailId: email.id, version: stale.searchVersion, document: toEmailDocument(stale) }]);
  assert.deepEqual(r.applied, [email.id], 'version conflict counts as already applied');
  await es.indices.refresh({ index: INDEX });
  assert.equal(await docCount({ term: { emailId: email.id } }), 1);
  assert.equal((await es.get<{ subject: string }>({ index: INDEX, id: email.id }))._source!.subject, 'Version two');
});

// --- SEARCH ----------------------------------------------------------------

test('S7–S9. free text matches recipient (full and partial), subject (incl. prefix) and body', async () => {
  const { client } = await seededTenant();
  const subjects = async (q: string) => (await search(client, { q, sort: 'relevance' })).body.items.map((i: { subject: string }) => i.subject).sort();

  assert.deepEqual(await subjects('bob@globex.com'), ['Welcome aboard']);
  assert.deepEqual(await subjects('globex'), ['Follow up', 'Welcome aboard']);
  assert.deepEqual(await subjects('acme.io'), ['Product launch', 'Quarterly report for Acme']);
  assert.deepEqual(await subjects('invoice'), ['Invoice 42']);
  assert.deepEqual(await subjects('quart'), ['Meeting notes', 'Quarterly report for Acme'], 'prefix on subject and body');
  assert.deepEqual(await subjects('thrilled partnership'), ['Welcome aboard'], 'body words');
  assert.deepEqual(await subjects('nonexistentword'), []);
});

test('S10. status filters (single and multiple)', async () => {
  const { client } = await seededTenant();
  const statuses = async (status: string) => (await search(client, { status, limit: 50 })).body.items.map((i: { status: string }) => i.status);
  assert.deepEqual([...new Set(await statuses('SENT'))], ['SENT']);
  assert.equal((await statuses('SENT')).length, 3);
  assert.equal((await statuses('SCHEDULED')).length, 3);
  assert.equal((await statuses('SENT,FAILED')).length, 4);
  const withQuery = await search(client, { q: 'globex', status: 'SCHEDULED' });
  assert.deepEqual(withQuery.body.items.map((i: { recipientEmail: string }) => i.recipientEmail), ['dave@globex.com']);
});

test('S11–S12. sorting by scheduledAt and sentAt', async () => {
  const { client, emails } = await seededTenant();
  const byScheduled = [...emails].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime()).map((e) => e.id);
  const asc = await search(client, { sort: 'scheduledAt', order: 'asc', limit: 50 });
  assert.deepEqual(asc.body.items.map((i: { id: string }) => i.id), byScheduled);
  const desc = await search(client, { sort: 'scheduledAt', order: 'desc', limit: 50 });
  assert.deepEqual(desc.body.items.map((i: { id: string }) => i.id), [...byScheduled].reverse());

  const sent = await search(client, { sort: 'sentAt', order: 'desc', limit: 50 });
  const sentAts = sent.body.items.map((i: { sentAt: string | null }) => i.sentAt);
  const present = sentAts.filter(Boolean) as string[];
  assert.deepEqual(present, [...present].sort().reverse(), 'newest sent first');
  assert.deepEqual(sentAts.slice(present.length), Array(sentAts.length - present.length).fill(null), 'unsent last');
});

test('S13–S14. pagination is disjoint and bounded; invalid parameters are rejected', async () => {
  const { client, emails } = await seededTenant();
  const pages = [];
  for (let page = 1; page <= 3; page++) pages.push(await search(client, { limit: 3, page, sort: 'createdAt', order: 'asc' }));
  const ids = pages.flatMap((p) => p.body.items.map((i: { id: string }) => i.id));
  assert.equal(pages[0]!.body.total, emails.length);
  assert.deepEqual(pages.map((p) => p.body.items.length), [3, 3, 1]);
  assert.equal(new Set(ids).size, emails.length, 'pages do not overlap');

  const invalid: Record<string, string | number>[] = [
    { limit: 101 },
    { limit: 0 },
    { page: 101, limit: 100 },
    { status: 'BOGUS' },
    { sort: 'body' },
    { order: 'sideways' },
    { senderId: 'not-a-uuid' },
  ];
  for (const params of invalid) {
    const res = await search(client, params);
    assert.equal(res.status, 400, JSON.stringify(params));
  }
  assert.equal((await search(client, { limit: 100 })).status, 200, 'max page size accepted');
});

// --- TENANT ----------------------------------------------------------------

test('T15–T17. search is always scoped to the session user', async () => {
  const { t: owner, emails } = await seededTenant();
  const other = await makeTenant();
  await makeEmail(other, new Date(), { subject: 'Other tenant only', recipientEmail: 'mallory@evil.test' });
  await waitIndexed(other.user.id, 1);
  const intruder = await signIn(other);

  // B searching A's subject, recipient, body, id: nothing.
  for (const q of ['Quarterly report', 'alice@acme.io', 'thrilled', emails[0]!.id]) {
    const res = await search(intruder, { q });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((i: { subject: string }) => i.subject).filter((s: string) => s !== 'Other tenant only'), [], q);
  }
  const all = await search(intruder, { limit: 100 });
  assert.deepEqual(all.body.items.map((i: { subject: string }) => i.subject), ['Other tenant only']);
  // Filtering by A's sender/campaign ids yields nothing for B.
  assert.equal((await search(intruder, { senderId: owner.sender.id })).body.total, 0);
  assert.equal((await search(intruder, { campaignId: owner.campaign.id })).body.total, 0);
  // A client-supplied userId is rejected, not used.
  assert.equal((await search(intruder, { userId: owner.user.id })).status, 400);
  // The owner can find the same document by id.
  const own = await search(seeded!.client, { q: emails[0]!.id });
  assert.deepEqual(own.body.items.map((i: { id: string }) => i.id), [emails[0]!.id]);
  // Unauthenticated: 401.
  assert.equal((await new TestClient(base).get('/api/emails/search')).status, 401);
});

// --- CONSISTENCY -----------------------------------------------------------

test('C18–C19. an indexing failure keeps the outbox row; the retry applies it once', async () => {
  const t = await makeTenant();
  // Outbox row committed with the email; apply it through an unreachable cluster first.
  const email = await prisma.$transaction(async (tx) => {
    const e = await tx.email.create({
      data: {
        userId: t.user.id, campaignId: t.campaign.id, senderId: t.sender.id, recipientEmail: 'c18@example.com',
        subject: 'Retry me', body: 'B', scheduledAt: new Date(), originalScheduledAt: new Date(), idempotencyKey: randomUUID(),
      },
    });
    return e;
  });
  const outbox = await prisma.searchOutbox.findMany({ where: { emailId: email.id } });
  assert.equal(outbox.length, 1, 'outbox row written in the same transaction');
  const ids = outbox.map((o) => o.id.toString());

  const down = createElasticsearchClient({ node: 'http://127.0.0.1:1', requestTimeoutMs: 1_000 });
  try {
    await assert.rejects(applyOutboxRows(ids, { client: down, index: INDEX }));
  } finally {
    await down.close();
  }
  // Applying the same rows through the real cluster works; retrying again is a no-op.
  await applyOutboxRows(ids, { client: es, index: INDEX }).catch(() => {});
  await waitIndexed(t.user.id, 1);
  const again = await applyOutboxRows(ids, { client: es, index: INDEX });
  assert.deepEqual(again, { applied: 0, skipped: 1 });
  await enqueueOutboxBatch(searchQueue, ids); // deterministic job id, harmless
  await es.indices.refresh({ index: INDEX });
  assert.equal(await docCount({ term: { emailId: email.id } }), 1);
  assert.equal(await prisma.searchOutbox.count({ where: { emailId: email.id } }), 0);
});

test('C20. an Elasticsearch outage does not affect sending; indexing catches up afterwards', { timeout: 120_000 }, async () => {
  const t = await makeTenant();
  const client = await signIn(t);
  // Own queue: no other test's worker may pick this job up.
  const { queue: outageQueue, prefix: outagePrefix } = newQueue();
  pauseElasticsearch();
  try {
    const email = await makeEmail(t, new Date(Date.now() - 1_000), { subject: 'Sent during outage' });
    await scheduleEmail(email.id, outageQueue);
    const worker = newWorker(outagePrefix, fakeDelivery().service, { rateLimiter: newLimiter() });
    const end = await waitForJobEnd(worker, emailJobId(email.id), 20_000);
    assert.equal(end.state, 'completed', 'email delivered while Elasticsearch is down');
    assert.equal((await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).status, 'SENT');

    const res = await search(client, { q: 'outage' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'search_unavailable');
    const health = await client.get('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.elasticsearch, 'down');
    assert.equal(health.body.status, 'degraded');
    assert.ok((await prisma.searchOutbox.count({ where: { emailId: email.id } })) > 0, 'changes wait in the outbox');
  } finally {
    unpauseElasticsearch();
  }

  await waitUntil(async () => {
    const res = await search(client, { q: 'outage' });
    return res.status === 200 && res.body.items.length === 1 && res.body.items[0].status === 'SENT';
  }, 60_000, 'index caught up');
  await es.indices.refresh({ index: INDEX });
  assert.equal(await docCount({ term: { userId: t.user.id } }), 1, 'no duplicates after retries');
  const ids = (await prisma.email.findMany({ where: { userId: t.user.id }, select: { id: true } })).map((e) => e.id);
  await waitUntil(async () => (await prisma.searchOutbox.count({ where: { emailId: { in: ids } } })) === 0, 20_000, 'outbox drained');
});

// --- BULL BOARD --------------------------------------------------------------

test('B22–B24. the dashboard is admin-only, read-only and lists all queues', async () => {
  const admin = await makeTenant();
  await prisma.user.update({ where: { id: admin.user.id }, data: { email: ADMIN_EMAIL } });
  const adminClient = await signIn(admin);
  const regular = await signIn(await makeTenant());
  const anon = new TestClient(base);

  assert.equal((await anon.get('/admin/queues')).status, 401);
  assert.equal((await anon.get('/admin/queues/api/queues')).status, 401);
  assert.equal((await anon.get('/api/admin/queues')).status, 401);
  assert.equal((await regular.get('/admin/queues')).status, 403);
  assert.equal((await regular.get('/admin/queues/api/queues')).status, 403);

  const page = await adminClient.get('/admin/queues');
  assert.equal(page.status, 200);
  assert.match(page.text, /<div id="root">/);
  // The UI's own assets load through the same authentication.
  const assets = [...page.text.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]!);
  assert.ok(assets.length > 0, 'dashboard references its assets');
  for (const asset of assets) {
    const url = asset.startsWith('/') ? asset : `/admin/queues/${asset}`;
    assert.equal((await adminClient.get(url)).status, 200, url);
    assert.equal((await anon.get(url)).status, 401, `asset ${url} is protected too`);
  }
  // Relaxed CSP only on the dashboard; API routes keep helmet's strict default.
  const dashCsp = (await fetch(`${base}/admin/queues`, { headers: { cookie: `${SESSION_COOKIE}=${adminClient.cookies.get(SESSION_COOKIE)}` } })).headers.get('content-security-policy') ?? '';
  assert.match(dashCsp, /script-src 'self' 'unsafe-inline'/);
  const apiCsp = (await fetch(`${base}/api/health`)).headers.get('content-security-policy') ?? '';
  assert.doesNotMatch(apiCsp, /unsafe-inline.*script|script-src[^;]*unsafe-inline/);
  const api = await adminClient.get('/admin/queues/api/queues');
  assert.equal(api.status, 200);
  const names = api.body.queues.map((q: { name: string }) => q.name).sort();
  assert.deepEqual(names, ['email-scheduler', 'search-index', 'slack-notifications']);
  assert.ok(api.body.queues.every((q: { readOnlyMode: boolean }) => q.readOnlyMode === true));
  const cleanAttempt = await adminClient.request('PUT', '/admin/queues/api/queues/search-index/clean/completed');
  assert.ok(cleanAttempt.status >= 400, `read-only dashboard refused mutation (${cleanAttempt.status})`);

  const summary = await adminClient.get('/api/admin/queues');
  assert.deepEqual(summary.body.queues.map((q: { name: string }) => q.name).sort(), names);
  assert.ok('waiting' in summary.body.queues[0].counts && 'failed' in summary.body.queues[0].counts);
});

// --- SECURITY ----------------------------------------------------------------

test('P25. queue payloads of every queue contain identifiers only', async () => {
  const t = await makeTenant();
  const email = await makeEmail(t, new Date(Date.now() + 3_600_000));
  await scheduleEmail(email.id, emailQueue);
  await enqueueHourlyLimitNotification(slackQueue, {
    userId: t.user.id, senderId: t.sender.id, campaignId: t.campaign.id, emailId: email.id,
    scope: 'sender', windowStart: new Date(), nextSlotAt: new Date(Date.now() + 3_600_000),
  });
  await waitIndexed(t.user.id, 1);

  const allowed: Record<string, string[]> = {
    'email-scheduler': ['campaignId', 'emailId', 'senderId', 'userId'],
    'slack-notifications': ['campaignId', 'nextSlotAt', 'scope', 'senderId', 'userId', 'windowStart'],
    'search-index': ['outboxIds'],
  };
  const redis = getRedisConnection();
  for (const queue of [emailQueue, slackQueue, searchQueue] as const) {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 200);
    assert.ok(jobs.length > 0, `${queue.name} has jobs to inspect`);
    for (const job of jobs) {
      assert.deepEqual(Object.keys(job.data).sort(), allowed[queue.name], `${queue.name} ${job.id}`);
      const raw = JSON.stringify(await redis.hgetall(`${queue.opts.prefix}:${queue.name}:${job.id}`));
      assert.doesNotMatch(raw, /password|xoxb|v1:[A-Za-z0-9+/]|ya29\.|ri_sid|secret|token/i, `${queue.name} ${job.id}`);
    }
  }
});

test('P26. search responses contain only safe display fields', async () => {
  const { client } = await seededTenant();
  const res = await search(client, { q: 'acme', limit: 10 });
  assert.equal(res.status, 200);
  const keys = Object.keys(res.body.items[0]).sort();
  assert.deepEqual(keys, ['campaign', 'createdAt', 'errorCode', 'id', 'previewUrl', 'recipientEmail', 'rescheduleCount', 'scheduledAt', 'sender', 'sentAt', 'snippet', 'status', 'subject']);
  assert.deepEqual(Object.keys(res.body.items[0].sender).sort(), ['displayName', 'email', 'id']);
  assert.deepEqual(Object.keys(res.body.items[0].campaign).sort(), ['id', 'subject']);
  assert.doesNotMatch(res.text, /smtp|password|Encrypted|token|userId|searchVersion|"body"/i);
});

// --- 1000+ -------------------------------------------------------------------

test('V2. 1000 emails inserted at once are bulk-indexed without duplicates or drops', { timeout: 180_000 }, async () => {
  const t = await makeTenant();
  const TOTAL = 1_000;
  const completedBefore = (await searchQueue.getJobCounts('completed')).completed ?? 0;
  const at = new Date();
  const started = Date.now();
  await prisma.email.createMany({
    data: Array.from({ length: TOTAL }, (_, i) => ({
      userId: t.user.id, campaignId: t.campaign.id, senderId: t.sender.id, recipientEmail: `bulk${i}@example.com`,
      subject: `Bulk ${i}`, body: 'B', scheduledAt: at, originalScheduledAt: at, idempotencyKey: randomUUID(),
    })),
  });
  await waitIndexed(t.user.id, TOTAL, 120_000);
  const elapsed = Date.now() - started;

  const unique = await es.search({
    index: INDEX, size: 0, query: { term: { userId: t.user.id } },
    aggs: { ids: { cardinality: { field: 'emailId', precision_threshold: 40_000 } } },
  });
  assert.equal((unique.aggregations!.ids as { value: number }).value, TOTAL, 'every email exactly once');
  const ids = (await prisma.email.findMany({ where: { userId: t.user.id }, select: { id: true } })).map((e) => e.id);
  assert.equal(await prisma.searchOutbox.count({ where: { emailId: { in: ids } } }), 0, 'outbox fully applied');
  const jobs = ((await searchQueue.getJobCounts('completed')).completed ?? 0) - completedBefore;
  assert.ok(jobs < TOTAL / 10, `batched into ${jobs} bulk jobs, not ${TOTAL} requests`);

  const reindex = await reindexEmails({ client: es, index: INDEX, userId: t.user.id, batchSize: 500 });
  assert.deepEqual([reindex.indexed, reindex.failed.length], [TOTAL, 0]);
  await es.indices.refresh({ index: INDEX });
  assert.equal(await docCount({ term: { userId: t.user.id } }), TOTAL, 'reindex added no duplicates');
  console.log(`V2: ${TOTAL} emails indexed via ${jobs} bulk jobs in ${elapsed}ms`);
});

test('X7. a campaign created through the API is indexed and searchable as scheduled', async () => {
  const t = await makeTenant();
  const client = await signIn(t);
  const created = await client.post('/api/campaigns', {
    senderId: t.sender.id,
    subject: 'Harvest festival invite',
    body: '<p>Join us for the <b>harvest</b> festival</p>',
    recipients: ['ann@farm.io', 'ben@farm.io', 'cat@orchard.io'],
    startAt: new Date(Date.now() + 3_600_000).toISOString(),
    delayBetweenEmailsSeconds: 30,
    hourlyLimit: 50,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await waitIndexed(t.user.id, 3);

  const res = await search(client, { q: 'harvest', status: 'SCHEDULED', sort: 'scheduledAt', order: 'asc' });
  assert.deepEqual(res.body.items.map((i: { recipientEmail: string }) => i.recipientEmail), ['ann@farm.io', 'ben@farm.io', 'cat@orchard.io']);
  assert.equal(res.body.items[0].snippet, 'Join us for the harvest festival');
  assert.equal(res.body.items[0].campaign.subject, 'Harvest festival invite');
  const gap = Date.parse(res.body.items[1].scheduledAt) - Date.parse(res.body.items[0].scheduledAt);
  assert.equal(gap, 30_000, 'planned 30 s apart');
  assert.equal((await search(client, { q: 'orchard' })).body.total, 1, 'recipient domain search');
});
