// Phase 7 integration tests: compose/campaign API on real PostgreSQL + Redis
// (BullMQ), recipient parsing, cancellation, and compatibility with the
// scheduler, worker and reconciliation from earlier phases.
import './setup.js';

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { createSession, SESSION_COOKIE } from '../src/auth/session.js';
import { deriveStatus } from '../src/campaigns/campaign.service.js';
import { parseRecipientText, RecipientInputError } from '../src/campaigns/recipients.js';
import { prisma } from '../src/lib/prisma.js';
import { emailJobId, type EmailQueue } from '../src/queue/email.queue.js';
import { processEmail } from '../src/services/email-processing.service.js';
import { reconcileEmailJobs } from '../src/services/email-scheduler.service.js';
import { cleanup, fakeDelivery, makeTenant, newLimiter, newQueue, newWorker, onCleanup, waitForJobEnd, type Tenant } from './helpers.js';
import { TestClient } from './http-client.js';

let base: string;
let queue: EmailQueue;
let prefix: string;

function startApp(emailQueue: EmailQueue) {
  const app = createApp({ google: null, slack: null, emailQueue, dashboardQueues: [emailQueue] });
  const server: http.Server = app.listen(0, '127.0.0.1');
  onCleanup(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return once(server, 'listening').then(() => `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}

before(async () => {
  ({ queue, prefix } = newQueue());
  base = await startApp(queue);
});
after(cleanup);

async function signIn(t: Tenant, url = base) {
  const client = new TestClient(url);
  client.cookies.set(SESSION_COOKIE, await createSession(t.user.id));
  return client;
}

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

function payload(t: Tenant, overrides: Record<string, unknown> = {}) {
  return {
    senderId: t.sender.id,
    subject: 'Quarterly update',
    body: '<p>Hello <b>there</b></p>',
    recipients: ['a@example.com', 'b@example.com'],
    startAt: inAnHour(),
    timezone: 'Asia/Kolkata',
    delayBetweenEmailsSeconds: 10,
    hourlyLimit: 60,
    ...overrides,
  };
}

// --- parsing ---------------------------------------------------------------

test('R1. recipient parser: separators, CSV headers, quotes, dedupe, invalid entries, limits', () => {
  const text = [
    'Name,Email,Company',
    'Jane,Jane@Acme.io,Acme',
    '"Doe, John",john@acme.io,"Acme, Inc"',
    'Dup,jane@acme.io,X',
    'Broken,not-an-email,Y',
  ].join('\n');
  const csv = parseRecipientText(text);
  assert.deepEqual(csv.emails, ['jane@acme.io', 'john@acme.io']);
  assert.deepEqual([csv.total, csv.valid, csv.invalid, csv.duplicatesRemoved], [4, 2, 1, 1]);
  assert.deepEqual(csv.invalidEntries, [{ row: 5, value: 'not-an-email' }]);

  const free = parseRecipientText('a@x.com, b@y.org;c@z.io  d@w.co\n<E@V.io>\nmailto:f@u.io');
  assert.deepEqual(free.emails, ['a@x.com', 'b@y.org', 'c@z.io', 'd@w.co', 'e@v.io', 'f@u.io']);
  assert.equal(parseRecipientText('user@localhost\nuser@@x.com').invalid, 2);
  assert.throws(() => parseRecipientText('a@b.co\n'.repeat(400_000)), RecipientInputError);
});

test('R2. POST /api/campaigns/recipients/parse returns server-side counts', async () => {
  const t = await makeTenant();
  const client = await signIn(t);
  const res = await client.post('/api/campaigns/recipients/parse', { text: 'email\nx@y.com\nX@Y.com\nbad\nz@y.com' });
  assert.equal(res.status, 200);
  assert.deepEqual(
    { emails: res.body.emails, total: res.body.total, valid: res.body.valid, invalid: res.body.invalid, duplicatesRemoved: res.body.duplicatesRemoved },
    { emails: ['x@y.com', 'z@y.com'], total: 4, valid: 2, invalid: 1, duplicatesRemoved: 1 },
  );
  assert.equal((await new TestClient(base).post('/api/campaigns/recipients/parse', { text: 'x@y.com' })).status, 401);
});

// --- creation --------------------------------------------------------------

test('C1. creating a campaign persists emails transactionally and schedules deterministic delayed jobs', async () => {
  const t = await makeTenant();
  const client = await signIn(t);
  const startAt = new Date(Date.now() + 2 * 3_600_000);
  const res = await client.post('/api/campaigns', payload(t, {
    startAt: startAt.toISOString(),
    recipients: ['c@example.com', 'a@example.com', 'B@example.com'],
    body: '<p onclick="steal()">Hi <b>there</b><script>alert(1)</script><img src=x onerror=alert(1)></p>',
  }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.created, true);
  assert.equal(res.body.queued, 3);
  assert.equal(res.body.pendingReconciliation, 0);
  assert.deepEqual(
    { total: res.body.recipients.total, valid: res.body.recipients.valid, invalid: res.body.recipients.invalid },
    { total: 3, valid: 3, invalid: 0 },
  );
  const c = res.body.campaign;
  assert.equal(c.status, 'SCHEDULED');
  assert.equal(c.totalEmails, 3);
  assert.equal(c.sender.id, t.sender.id);
  assert.equal(c.timezone, 'Asia/Kolkata');
  assert.equal(c.hourlyLimit, 60);
  assert.equal(c.delayBetweenEmailsMs, 10_000);

  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(campaign.userId, t.user.id);
  assert.equal(campaign.body, '<p>Hi <b>there</b></p>', 'HTML sanitized on the server before persistence');

  const emails = await prisma.email.findMany({ where: { campaignId: c.id }, orderBy: { scheduledAt: 'asc' } });
  assert.deepEqual(emails.map((e) => e.recipientEmail), ['c@example.com', 'a@example.com', 'b@example.com'], 'input order kept');
  emails.forEach((e, i) => {
    assert.equal(e.scheduledAt.getTime(), startAt.getTime() + i * 10_000);
    assert.equal(e.originalScheduledAt.getTime(), e.scheduledAt.getTime());
    assert.equal(e.senderId, t.sender.id);
    assert.equal(e.status, 'SCHEDULED');
    assert.equal(e.idempotencyKey, createHash('sha256').update(`${c.id}:${e.recipientEmail}`).digest('hex'));
    assert.equal(e.body, campaign.body);
  });

  for (const e of emails) {
    const job = await queue.getJob(emailJobId(e.id));
    assert.ok(job, 'job exists');
    assert.equal(await job.getState(), 'delayed');
    assert.deepEqual(job.data, { emailId: e.id, userId: t.user.id, campaignId: c.id, senderId: t.sender.id });
    assert.ok(Math.abs(job.timestamp + job.delay - e.scheduledAt.getTime()) < 1_000);
  }
});

test('C2. invalid recipients are rejected with details and nothing is created', async () => {
  const t = await makeTenant();
  const client = await signIn(t);
  const res = await client.post('/api/campaigns', payload(t, { recipients: ['ok@example.com', 'broken@', 'also bad'] }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_recipients');
  assert.equal(res.body.error.details.invalid, 2);
  assert.equal(res.body.error.details.valid, 1);
  assert.equal(res.body.error.details.invalidEntries.length, 2);
  assert.equal(await prisma.campaign.count({ where: { userId: t.user.id, id: { not: t.campaign.id } } }), 0);
});

test('C3. duplicates are removed and reported (CSV + chips combined)', async () => {
  const t = await makeTenant();
  const client = await signIn(t);
  const res = await client.post('/api/campaigns', payload(t, {
    recipients: ['x@example.com', 'X@example.com'],
    recipientsText: 'email\nx@example.com\ny@example.com',
  }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual([res.body.recipients.valid, res.body.recipients.duplicatesRemoved], [2, 2]);
  assert.equal(await prisma.email.count({ where: { campaignId: res.body.campaign.id } }), 2);
});

test('C4. strict validation of every field', async () => {
  const t = await makeTenant();
  const client = await signIn(t);
  const bad: [string, Record<string, unknown>][] = [
    ['empty subject', { subject: '   ' }],
    ['empty body', { body: '<p> </p><p><br></p>' }],
    ['script-only body', { body: '<script>alert(1)</script>' }],
    ['negative delay', { delayBetweenEmailsSeconds: -1 }],
    ['huge delay', { delayBetweenEmailsSeconds: 99_999 }],
    ['zero hourly limit', { hourlyLimit: 0 }],
    ['fractional limit', { hourlyLimit: 1.5 }],
    ['past start', { startAt: new Date(Date.now() - 3_600_000).toISOString() }],
    ['start without offset', { startAt: '2031-01-01T10:00:00' }],
    ['not a date', { startAt: 'tomorrow' }],
    ['unknown time zone', { timezone: 'Mars/Olympus' }],
    ['no recipients', { recipients: [] }],
    ['client userId', { userId: randomUUID() }],
    ['bad sender id', { senderId: 'nope' }],
  ];
  for (const [label, overrides] of bad) {
    const res = await client.post('/api/campaigns', payload(t, overrides));
    assert.equal(res.status, 400, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  assert.equal(await prisma.campaign.count({ where: { userId: t.user.id, id: { not: t.campaign.id } } }), 0);
});

test('C5. another tenant\'s or an inactive sender cannot be used', async () => {
  const owner = await makeTenant();
  const other = await makeTenant();
  const client = await signIn(owner);
  const cross = await client.post('/api/campaigns', payload(owner, { senderId: other.sender.id }));
  assert.equal(cross.status, 404);
  await prisma.sender.update({ where: { id: owner.sender.id }, data: { isActive: false } });
  const inactive = await client.post('/api/campaigns', payload(owner));
  assert.equal(inactive.status, 400);
  assert.equal(inactive.body.error.code, 'sender_inactive');
  assert.equal(await prisma.campaign.count({ where: { userId: { in: [owner.user.id, other.user.id] }, id: { notIn: [owner.campaign.id, other.campaign.id] } } }), 0);
});

test('C6. a repeated or concurrent submission (same clientRequestId) creates one campaign', async () => {
  const t = await makeTenant();
  const client = await signIn(t);
  const body = payload(t, { clientRequestId: `req-${randomUUID()}` });
  const [a, b] = await Promise.all([client.post('/api/campaigns', body), client.post('/api/campaigns', body)]);
  const again = await client.post('/api/campaigns', body);
  const ids = new Set([a.body.campaign.id, b.body.campaign.id, again.body.campaign.id]);
  assert.equal(ids.size, 1);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(again.status, 200);
  assert.equal(await prisma.campaign.count({ where: { userId: t.user.id, id: { not: t.campaign.id } } }), 1);
  assert.equal(await prisma.email.count({ where: { userId: t.user.id } }), 2);
  const jobs = await queue.getJobs(['delayed']);
  assert.equal(jobs.filter((j) => j.data.userId === t.user.id).length, 2);
});

test('C7. 1500 recipients from a CSV are created and scheduled efficiently', { timeout: 120_000 }, async () => {
  const t = await makeTenant({ senderHourlyLimit: 10_000 });
  const client = await signIn(t);
  const csv = ['email,name', ...Array.from({ length: 1_500 }, (_, i) => `lead${i}@bulk.example.com,Lead ${i}`)].join('\n');
  const started = Date.now();
  const res = await client.post('/api/campaigns', payload(t, { recipients: [], recipientsText: csv, delayBetweenEmailsSeconds: 2, hourlyLimit: 5_000 }));
  const elapsed = Date.now() - started;
  assert.equal(res.status, 201, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.queued, 1_500);
  assert.equal(res.body.campaign.totalEmails, 1_500);
  assert.equal(await prisma.email.count({ where: { campaignId: res.body.campaign.id } }), 1_500);
  const delayed = await queue.getJobs(['delayed'], 0, 5_000);
  assert.equal(delayed.filter((j) => j.data.campaignId === res.body.campaign.id).length, 1_500);
  assert.ok(elapsed < 20_000, `took ${elapsed}ms`);
  console.log(`C7: 1500-recipient campaign created + scheduled in ${elapsed}ms`);
});

// --- listing / detail --------------------------------------------------------

test('C8. list and detail are tenant-scoped and status is derived from email state', async () => {
  const t = await makeTenant();
  const other = await makeTenant();
  const client = await signIn(t);
  const intruder = await signIn(other);
  const created = await client.post('/api/campaigns', payload(t, { recipients: ['1@ex.com', '2@ex.com', '3@ex.com'] }));
  const id = created.body.campaign.id;

  // (makeTenant also creates a fixture campaign without emails: DRAFT.)
  const list = await client.get('/api/campaigns');
  assert.deepEqual(list.body.map((c: { id: string }) => c.id).sort(), [id, t.campaign.id].sort());
  const listed = list.body.find((c: { id: string }) => c.id === id);
  assert.equal(listed.sender.email, t.sender.email);
  assert.equal(listed.totalEmails, 3);
  assert.equal(listed.status, 'SCHEDULED');
  assert.equal(list.body.find((c: { id: string }) => c.id === t.campaign.id).status, 'DRAFT');
  assert.deepEqual((await intruder.get('/api/campaigns')).body.map((c: { id: string }) => c.id), [other.campaign.id]);
  assert.equal((await intruder.get(`/api/campaigns/${id}`)).status, 404);
  assert.equal((await intruder.post(`/api/campaigns/${id}/cancel`)).status, 404);

  const emails = await prisma.email.findMany({ where: { campaignId: id }, orderBy: { scheduledAt: 'asc' } });
  await prisma.email.update({ where: { id: emails[0]!.id }, data: { status: 'SENT', sentAt: new Date() } });
  assert.equal((await client.get(`/api/campaigns/${id}`)).body.status, 'RUNNING');
  await prisma.email.updateMany({ where: { campaignId: id }, data: { status: 'SENT', sentAt: new Date() } });
  const detail = await client.get(`/api/campaigns/${id}`);
  assert.equal(detail.body.status, 'COMPLETED');
  assert.equal(detail.body.emailCounts.SENT, 3);
  assert.equal(detail.body.emails.length, 3);
  assert.doesNotMatch(detail.text, /smtpPassword|Encrypted|idempotencyKey|processingToken/);
  assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id } })).status, 'COMPLETED', 'derived status stored');

  assert.equal(deriveStatus('SCHEDULED', { SCHEDULED: 0, PROCESSING: 0, SENT: 0, FAILED: 0, CANCELLED: 0, DELIVERY_UNKNOWN: 0 }), 'DRAFT');
  assert.equal(deriveStatus('CANCELLED', { SCHEDULED: 1, PROCESSING: 0, SENT: 0, FAILED: 0, CANCELLED: 0, DELIVERY_UNKNOWN: 0 }), 'CANCELLED');
});

test('C9. email detail serves sanitized HTML and safe fields only', async () => {
  const t = await makeTenant();
  const client = await signIn(t);
  const created = await client.post('/api/campaigns', payload(t, { recipients: ['d@ex.com'] }));
  const email = await prisma.email.findFirstOrThrow({ where: { campaignId: created.body.campaign.id } });
  // A body stored before sanitization existed must still be served safely.
  await prisma.email.update({ where: { id: email.id }, data: { body: '<p>Hi<script>x()</script><a href="javascript:x()">l</a><img src=x onerror=y()></p>' } });
  const res = await client.get(`/api/emails/${email.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.bodyHtml, '<p>Hi<a target="_blank" rel="noopener noreferrer">l</a></p>');
  assert.equal(res.body.sender.email, t.sender.email);
  assert.equal(res.body.campaign.subject, 'Quarterly update');
  assert.doesNotMatch(res.text, /smtp|Encrypted|token|idempotency/i);
});

// --- cancellation ------------------------------------------------------------

test('C10. cancel stops unsent emails only, removes their jobs and is idempotent', async () => {
  const t = await makeTenant();
  const client = await signIn(t);
  const created = await client.post('/api/campaigns', payload(t, { recipients: ['1@c.io', '2@c.io', '3@c.io', '4@c.io', '5@c.io'] }));
  const id = created.body.campaign.id;
  const emails = await prisma.email.findMany({ where: { campaignId: id }, orderBy: { scheduledAt: 'asc' } });
  await prisma.email.update({ where: { id: emails[0]!.id }, data: { status: 'SENT', sentAt: new Date() } });
  await prisma.email.update({ where: { id: emails[1]!.id }, data: { status: 'PROCESSING', processingToken: randomUUID() } });

  const res = await client.post(`/api/campaigns/${id}/cancel`);
  assert.equal(res.status, 200);
  assert.equal(res.body.cancelledEmails, 3);
  assert.equal(res.body.jobsRemoved, 3);
  assert.equal(res.body.campaign.status, 'CANCELLED');
  const after = await prisma.email.findMany({ where: { campaignId: id }, orderBy: { scheduledAt: 'asc' } });
  assert.deepEqual(after.map((e) => e.status), ['SENT', 'PROCESSING', 'CANCELLED', 'CANCELLED', 'CANCELLED']);
  for (const e of after.slice(2)) assert.equal(await queue.getJob(emailJobId(e.id)), undefined);

  const again = await client.post(`/api/campaigns/${id}/cancel`);
  assert.equal(again.body.cancelledEmails, 0);
  // Reconciliation does not bring cancelled emails back.
  const r = await reconcileEmailJobs({ queue, userId: t.user.id });
  assert.equal(r.scheduled, 0);
});

test('C11. a worker cannot claim an email of a cancelled campaign (e.g. one deferred back to SCHEDULED)', async () => {
  const t = await makeTenant();
  const client = await signIn(t);
  const created = await client.post('/api/campaigns', payload(t, { recipients: ['late@c.io'], startAt: new Date().toISOString() }));
  const email = await prisma.email.findFirstOrThrow({ where: { campaignId: created.body.campaign.id } });
  // Campaign cancelled while this email was PROCESSING, then deferred back to SCHEDULED.
  await prisma.campaign.update({ where: { id: created.body.campaign.id }, data: { status: 'CANCELLED' } });
  const delivery = fakeDelivery();
  const result = await processEmail(
    { emailId: email.id, userId: t.user.id, campaignId: email.campaignId, senderId: email.senderId },
    { delivery: delivery.service, rateLimiter: newLimiter() },
  );
  assert.deepEqual(result, { outcome: 'skipped', emailId: email.id, reason: 'campaign_cancelled' });
  assert.equal(delivery.calls.length, 0);
  assert.equal((await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).status, 'CANCELLED');
});

// --- scheduler / worker compatibility ---------------------------------------

test('C12. the worker sends a due campaign with the campaign delay enforced; status becomes COMPLETED', async () => {
  const { queue: q, prefix: p } = newQueue();
  const url = await startApp(q);
  const t = await makeTenant();
  const client = await signIn(t, url);
  const created = await client.post('/api/campaigns', payload(t, {
    recipients: ['s1@ex.com', 's2@ex.com', 's3@ex.com'],
    startAt: new Date().toISOString(),
    delayBetweenEmailsSeconds: 1,
  }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const emails = await prisma.email.findMany({ where: { campaignId: created.body.campaign.id }, orderBy: { scheduledAt: 'asc' } });
  const delivery = fakeDelivery();
  const worker = newWorker(p, delivery.service, { rateLimiter: newLimiter() });
  await Promise.all(emails.map((e) => waitForJobEnd(worker, emailJobId(e.id), 20_000)));

  const sent = await prisma.email.findMany({ where: { campaignId: created.body.campaign.id }, orderBy: { deliveryStartedAt: 'asc' } });
  assert.ok(sent.every((e) => e.status === 'SENT'));
  assert.deepEqual(delivery.calls.map((c) => c.recipientEmail), ['s1@ex.com', 's2@ex.com', 's3@ex.com']);
  const gaps = sent.slice(1).map((e, i) => e.deliveryStartedAt!.getTime() - sent[i]!.deliveryStartedAt!.getTime());
  assert.ok(gaps.every((g) => g >= 1_000), `gaps ${gaps}`);
  assert.equal((await client.get(`/api/campaigns/${created.body.campaign.id}`)).body.status, 'COMPLETED');
  void prefix;
});

test('C13. if queueing fails after the commit, the response says so and reconciliation recovers every email', async () => {
  const { queue: real } = newQueue();
  const broken = new Proxy(real, {
    get: (target, prop, receiver) =>
      prop === 'addBulk' ? () => Promise.reject(new Error('redis unavailable')) : Reflect.get(target, prop, receiver),
  }) as EmailQueue;
  const url = await startApp(broken);
  const t = await makeTenant();
  const client = await signIn(t, url);
  const res = await client.post('/api/campaigns', payload(t, { recipients: ['r1@ex.com', 'r2@ex.com', 'r3@ex.com'] }));
  assert.equal(res.status, 201);
  assert.equal(res.body.queued, 0);
  assert.equal(res.body.pendingReconciliation, 3);
  assert.equal(await prisma.email.count({ where: { campaignId: res.body.campaign.id, status: 'SCHEDULED' } }), 3, 'nothing lost');

  const recovered = await reconcileEmailJobs({ queue: real, userId: t.user.id });
  assert.equal(recovered.scheduled, 3);
  assert.equal((await reconcileEmailJobs({ queue: real, userId: t.user.id })).scheduled, 0, 'no duplicates');
  assert.equal((await real.getJobs(['delayed'])).filter((j) => j.data.userId === t.user.id).length, 3);
});
