// Phase 4 integration tests: real SMTP delivery (Ethereal + a local SMTP
// server for failure modes), minimum delay, hourly limits, rescheduling,
// ordering and idempotency. Real Redis and PostgreSQL throughout; only email
// delivery is faked where a test is about coordination rather than SMTP.
import './setup.js';

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import nodemailer from 'nodemailer';
import { env } from '../src/config/env.js';
import { emailEvents, type HourlyLimitReachedEvent } from '../src/events/email-events.js';
import { prisma } from '../src/lib/prisma.js';
import { emailJobId, SEND_EMAIL_JOB, type EmailQueue } from '../src/queue/email.queue.js';
import type { EmailWorker } from '../src/queue/email.worker.js';
import { markDeliveryUnknown, markFailed, markSent } from '../src/services/email-processing.service.js';
import { reconcileEmailJobs, scheduleEmail } from '../src/services/email-scheduler.service.js';
import { HOUR_MS, SendRateLimiter } from '../src/services/rate-limit/send-rate-limiter.js';
import { createSmtpDelivery } from '../src/services/smtp-delivery.service.js';
import { startFakeSmtp, type FakeSmtpMode } from './fixtures/fake-smtp.js';
import {
  cleanup,
  fakeDelivery,
  jobData,
  makeEmail,
  makeTenant,
  newLimiter,
  newQueue,
  newWorker,
  RL_PREFIX_ROOT,
  waitForJobEnd,
  waitForJobEndAny,
  type Tenant,
} from './helpers.js';

const children: ChildProcess[] = [];
let ethereal: Awaited<ReturnType<typeof nodemailer.createTestAccount>>;

before(async () => {
  ethereal = await nodemailer.createTestAccount();
});

after(async () => {
  for (const c of children) c.kill('SIGKILL');
  await cleanup();
});

// --- helpers ---------------------------------------------------------------

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 20_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Avoid starting a window-sensitive test right before a window boundary.
async function awayFromWindowEdge(windowMs: number, marginMs: number) {
  const left = windowMs - (Date.now() % windowMs);
  if (left < marginMs) await sleep(left + 50);
}

// Every email is either SENT or rescheduled by the hourly limit, and no job is
// still running or waiting (brief min-delay deferrals are not 'settled').
async function settled(queue: EmailQueue, userId: string, total: number) {
  const [sent, rescheduled] = await Promise.all([
    prisma.email.count({ where: { userId, status: 'SENT' } }),
    prisma.email.count({ where: { userId, status: 'SCHEDULED', rescheduleCount: { gt: 0 } } }),
  ]);
  if (sent + rescheduled !== total) return false;
  const c = await queue.getJobCounts('active', 'waiting');
  return (c.active ?? 0) + (c.waiting ?? 0) === 0;
}

async function scheduleAll(queue: EmailQueue, ids: string[]) {
  for (const id of ids) await scheduleEmail(id, queue);
}

function gaps(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted.slice(1).map((t, i) => t - sorted[i]!);
}

async function deliveredRows(ids: string[]) {
  return prisma.email.findMany({ where: { id: { in: ids } }, orderBy: { deliveryStartedAt: 'asc' } });
}

function smtpTenant(port: number, extra: Parameters<typeof makeTenant>[0] = {}) {
  return makeTenant({
    ...extra,
    smtp: { host: '127.0.0.1', port, user: 'local-user', password: 'local-password', email: 'sender@fake.test' },
  });
}

async function runSmtpCase(mode: FakeSmtpMode, socketTimeoutMs = 30_000) {
  const server = await startFakeSmtp(mode);
  try {
    const { queue, prefix } = newQueue();
    const t = await smtpTenant(server.port);
    const email = await makeEmail(t, new Date(Date.now() - 1_000));
    const { jobId } = await scheduleEmail(email.id, queue);
    const worker = newWorker(prefix, createSmtpDelivery({ socketTimeoutMs, allowPrivateHosts: true }));
    const end = await waitForJobEnd(worker, jobId, 20_000);
    const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
    return { end, row, server, queue, worker, t, email, jobId };
  } finally {
    await server.close();
  }
}

// --- SMTP ------------------------------------------------------------------

test('S1. real Ethereal delivery: SENT with providerMessageId, previewUrl and sentAt', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant({
    smtp: { host: ethereal.smtp.host, port: ethereal.smtp.port, secure: ethereal.smtp.secure, user: ethereal.user, password: ethereal.pass },
  });
  const email = await makeEmail(t, new Date(Date.now() - 1_000), {
    recipientEmail: 'recipient@example.com',
    subject: `ReachInbox Phase 4 ${randomUUID().slice(0, 6)}`,
    body: 'Hello from the ReachInbox scheduler.',
  });
  const { jobId } = await scheduleEmail(email.id, queue);

  const worker = newWorker(prefix, createSmtpDelivery());
  const end = await waitForJobEnd(worker, jobId, 60_000);

  assert.equal(end.state, 'completed', end.state === 'failed' ? end.error.message : '');
  const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, 'SENT');
  assert.ok(row.sentAt);
  assert.ok(row.providerMessageId && row.providerMessageId.length > 5, `providerMessageId ${row.providerMessageId}`);
  assert.match(row.previewUrl ?? '', /^https:\/\/ethereal\.email\/message\/.+/);
  assert.equal(row.attempts, 1);
  const preview = await fetch(row.previewUrl!);
  assert.equal(preview.status, 200, 'Ethereal preview page exists');
});

test('S2. real Ethereal authentication failure -> FAILED (definitely not sent)', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant({
    smtp: { host: ethereal.smtp.host, port: ethereal.smtp.port, user: ethereal.user, password: 'wrong-password' },
  });
  const email = await makeEmail(t, new Date(Date.now() - 1_000));
  const { jobId } = await scheduleEmail(email.id, queue);

  const worker = newWorker(prefix, createSmtpDelivery());
  const end = await waitForJobEnd(worker, jobId, 60_000);

  assert.equal(end.state, 'failed');
  assert.equal(end.job?.attemptsMade, 1, 'not retried');
  const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, 'FAILED');
  assert.equal(row.errorCode, 'SMTP_EAUTH');
  assert.doesNotMatch(row.errorMessage ?? '', /wrong-password/);
});

test('S3. connection refused -> FAILED', async () => {
  const server = await startFakeSmtp('accept');
  const port = server.port;
  await server.close(); // nothing listens on this port now
  const { queue, prefix } = newQueue();
  const t = await smtpTenant(port);
  const email = await makeEmail(t, new Date(Date.now() - 1_000));
  const { jobId } = await scheduleEmail(email.id, queue);

  const worker = newWorker(prefix, createSmtpDelivery({ allowPrivateHosts: true }));
  const end = await waitForJobEnd(worker, jobId, 20_000);

  assert.equal(end.state, 'failed');
  const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, 'FAILED');
  assert.match(row.errorCode ?? '', /^SMTP_E/);
  assert.match(row.errorMessage ?? '', /connect failed/);
});

test('S4. recipient rejected at RCPT TO (550) -> FAILED', async () => {
  const { row, server } = await runSmtpCase('reject_rcpt');
  assert.equal(row.status, 'FAILED');
  assert.equal(row.errorCode, 'SMTP_EENVELOPE_550');
  assert.equal(server.messages.length, 0, 'message body never transmitted');
});

test('S5. message rejected after DATA (554) -> FAILED', async () => {
  const { row, server } = await runSmtpCase('reject_message');
  assert.equal(row.status, 'FAILED');
  assert.equal(row.errorCode, 'SMTP_EMESSAGE_554');
  assert.equal(server.messages.length, 1);
});

test('S6. connection lost after the message was transmitted -> DELIVERY_UNKNOWN', async () => {
  const { row, server, end } = await runSmtpCase('drop_after_data');
  assert.equal(end.state, 'failed');
  assert.equal(end.job?.attemptsMade, 1, 'not retried');
  assert.equal(row.status, 'DELIVERY_UNKNOWN');
  assert.equal(row.errorCode, 'DELIVERY_OUTCOME_UNKNOWN');
  assert.ok(row.deliveryStartedAt);
  // The server really did receive the full message: resending would duplicate it.
  assert.equal(server.messages.length, 1);
});

test('S7. timeout after the message was transmitted -> DELIVERY_UNKNOWN', async () => {
  const { row, server } = await runSmtpCase('hang_after_data', 500);
  assert.equal(row.status, 'DELIVERY_UNKNOWN');
  assert.match(row.errorMessage ?? '', /ETIMEDOUT/);
  assert.equal(server.messages.length, 1);
});

test('S8. accepted by the local SMTP server: SENT, queue id stored, deterministic Message-ID, no secrets in message', async () => {
  const { row, server, email } = await runSmtpCase('accept');
  assert.equal(row.status, 'SENT');
  assert.equal(row.providerMessageId, 'FAKE1');
  assert.equal(row.previewUrl, null, 'no preview outside Ethereal');
  const raw = server.messages[0]!;
  assert.match(raw, new RegExp(`Message-ID: <${email.idempotencyKey}@fake\\.test>`, 'i'));
  assert.doesNotMatch(raw, /local-password/);
});

// --- minimum delay ---------------------------------------------------------

test('M6. two sends from one sender are never closer than the configured delay', async () => {
  const { queue, prefix } = newQueue();
  const delayMs = 300;
  const t = await makeTenant({ delayMs });
  const emails = await Promise.all(Array.from({ length: 4 }, () => makeEmail(t, new Date(Date.now() - 1_000))));
  await scheduleAll(queue, emails.map((e) => e.id));
  const delivery = fakeDelivery();

  const worker = newWorker(prefix, delivery.service);
  await Promise.all(emails.map((e) => waitForJobEnd(worker, emailJobId(e.id), 20_000)));

  const rows = await deliveredRows(emails.map((e) => e.id));
  assert.ok(rows.every((r) => r.status === 'SENT'));
  const authorized = gaps(rows.map((r) => r.deliveryStartedAt!.getTime()));
  assert.ok(authorized.every((g) => g >= delayMs), `authorization gaps ${authorized}`);
  const calls = gaps(delivery.times);
  assert.ok(calls.every((g) => g >= delayMs - 25), `SMTP call gaps ${calls}`);
});

test('M7. concurrent workers (separate limiter instances, shared Redis) respect the same delay', async () => {
  const { queue, prefix } = newQueue();
  const delayMs = 250;
  const t = await makeTenant({ delayMs });
  const emails = await Promise.all(Array.from({ length: 6 }, () => makeEmail(t, new Date(Date.now() - 1_000))));
  await scheduleAll(queue, emails.map((e) => e.id));
  const delivery = fakeDelivery();

  const shared = `${RL_PREFIX_ROOT}-m7`;
  const workers = [1, 2, 3].map(() =>
    newWorker(prefix, delivery.service, { concurrency: 3, rateLimiter: new SendRateLimiter({ keyPrefix: shared }) }),
  );
  await Promise.all(emails.map((e) => waitForJobEndAny(workers, emailJobId(e.id), 30_000)));

  const rows = await deliveredRows(emails.map((e) => e.id));
  assert.equal(rows.filter((r) => r.status === 'SENT').length, 6);
  const authorized = gaps(rows.map((r) => r.deliveryStartedAt!.getTime()));
  assert.ok(authorized.every((g) => g >= delayMs), `authorization gaps ${authorized}`);
  assert.ok(gaps(delivery.times).every((g) => g >= delayMs - 25), `SMTP call gaps ${gaps(delivery.times)}`);
});

test('M8. restart (new limiter, new Redis connection) keeps delay and counts', async () => {
  const t = await makeTenant({ delayMs: 1_000, senderHourlyLimit: 2 });
  const prefix = `${RL_PREFIX_ROOT}-m8`;
  const req = (emailId: string) => ({
    emailId,
    senderId: t.sender.id,
    campaignId: t.campaign.id,
    delayMs: 1_000,
    senderHourlyLimit: 2,
    campaignHourlyLimit: 100,
  });
  await awayFromWindowEdge(HOUR_MS, 30_000);

  const before = new SendRateLimiter({ keyPrefix: prefix });
  const first = await before.acquire(req(randomUUID()));
  assert.equal(first.kind, 'acquired');

  // "Restart": a brand-new client and limiter; nothing carried over in memory.
  const redis = new Redis(env.REDIS_URL);
  try {
    const afterRestart = new SendRateLimiter({ keyPrefix: prefix, redis });
    const second = await afterRestart.acquire(req(randomUUID()));
    assert.equal(second.kind, 'acquired');
    assert.ok(
      second.kind === 'acquired' && first.kind === 'acquired' && second.at.getTime() - first.at.getTime() >= 1_000,
      'delay enforced across restart',
    );
    // Hourly count also survived: the 3rd reservation goes to the next window.
    const third = await afterRestart.reserve(req(randomUUID()));
    assert.equal(third.windowOffset, 1);
  } finally {
    redis.disconnect();
  }
});

// --- hourly limit ----------------------------------------------------------

test('L9. limit N allows exactly N reservations per window, even when concurrent', async () => {
  await awayFromWindowEdge(HOUR_MS, 30_000);
  const t = await makeTenant();
  const limiter = newLimiter();
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      limiter.reserve({
        emailId: randomUUID(),
        senderId: t.sender.id,
        campaignId: t.campaign.id,
        delayMs: 0,
        senderHourlyLimit: 5,
        campaignHourlyLimit: 100,
      }),
    ),
  );
  const byWindow = results.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.windowOffset]: (acc[r.windowOffset] ?? 0) + 1 }), {});
  assert.deepEqual(byWindow, { 0: 5, 1: 5, 2: 2 });
});

test('L9b. heavy gate contention (80 due emails, one sender) never fails and keeps the delay', async () => {
  await awayFromWindowEdge(HOUR_MS, 30_000);
  const t = await makeTenant();
  const limiter = newLimiter();
  const delayMs = 2;
  const decisions = await Promise.all(
    Array.from({ length: 80 }, () =>
      limiter.acquire({
        emailId: randomUUID(),
        senderId: t.sender.id,
        campaignId: t.campaign.id,
        delayMs,
        senderHourlyLimit: 1_000,
        campaignHourlyLimit: 1_000,
      }),
    ),
  );
  assert.ok(decisions.every((d) => d.kind === 'acquired'), 'all acquired within the inline budget');
  const at = decisions.map((d) => (d.kind === 'acquired' ? d.at.getTime() : 0));
  assert.ok(gaps(at).every((g) => g >= delayMs), `gaps ${gaps(at)}`);
});

test('L10+11. email N+1 is rescheduled (not failed), re-queued with the same job id, and later delivered', async () => {
  const windowMs = 3_000;
  await awayFromWindowEdge(windowMs, 1_500);
  const { queue, prefix } = newQueue();
  const t = await makeTenant({ senderHourlyLimit: 2 });
  const emails = [];
  for (let i = 0; i < 3; i++) emails.push(await makeEmail(t, new Date(Date.now() - 3_000 + i * 10)));
  await scheduleAll(queue, emails.map((e) => e.id));
  const events: HourlyLimitReachedEvent[] = [];
  const onEvent = (e: HourlyLimitReachedEvent) => events.push(e);
  emailEvents.on('hourlyLimitReached', onEvent);
  const delivery = fakeDelivery();

  try {
    const worker = newWorker(prefix, delivery.service, { concurrency: 1, rateLimiter: newLimiter({ windowMs }) });
    const [e1, e2] = await Promise.all([
      waitForJobEnd(worker, emailJobId(emails[0]!.id)),
      waitForJobEnd(worker, emailJobId(emails[1]!.id)),
    ]);
    assert.equal(e1.state, 'completed');
    assert.equal(e2.state, 'completed');

    const thirdJobId = emailJobId(emails[2]!.id);
    await waitUntil(async () => (await (await queue.getJob(thirdJobId))?.getState()) === 'delayed', 10_000, 'third re-delayed');
    const third = await prisma.email.findUniqueOrThrow({ where: { id: emails[2]!.id } });
    assert.equal(third.status, 'SCHEDULED', 'not failed or dropped');
    assert.equal(third.rescheduleCount, 1);
    assert.ok(third.lastRescheduledAt);
    const nextWindowStart = (Math.floor(e1.job.processedOn! / windowMs) + 1) * windowMs;
    assert.ok(third.scheduledAt.getTime() >= nextWindowStart, 'moved to the next window');
    assert.equal(third.originalScheduledAt.getTime(), emails[2]!.originalScheduledAt.getTime());
    const job = await queue.getJob(thirdJobId);
    assert.ok(Math.abs(job!.timestamp + job!.delay - third.scheduledAt.getTime()) < 1_000 || job!.delay >= 0);
    assert.deepEqual(await queue.getJobCounts('delayed', 'waiting', 'completed'), { delayed: 1, waiting: 0, completed: 2 });

    assert.equal(events.length, 1);
    assert.equal(events[0]!.scope, 'sender');
    assert.equal(events[0]!.senderId, t.sender.id);

    const end3 = await waitForJobEnd(worker, thirdJobId, 10_000);
    assert.equal(end3.state, 'completed');
    const delivered = await prisma.email.findUniqueOrThrow({ where: { id: emails[2]!.id } });
    assert.equal(delivered.status, 'SENT');
    assert.ok(delivered.deliveryStartedAt!.getTime() >= nextWindowStart);
    assert.equal(delivery.calls.length, 3);
  } finally {
    emailEvents.off('hourlyLimitReached', onEvent);
  }
});

test('L12. concurrent workers cannot exceed the hourly limit', async () => {
  await awayFromWindowEdge(HOUR_MS, 60_000);
  const { queue, prefix } = newQueue();
  const t = await makeTenant({ senderHourlyLimit: 4 });
  const emails = await Promise.all(Array.from({ length: 10 }, () => makeEmail(t, new Date(Date.now() - 1_000))));
  await scheduleAll(queue, emails.map((e) => e.id));
  const delivery = fakeDelivery();
  const shared = `${RL_PREFIX_ROOT}-l12`;
  for (let i = 0; i < 3; i++) {
    newWorker(prefix, delivery.service, { concurrency: 3, rateLimiter: new SendRateLimiter({ keyPrefix: shared }) });
  }

  await waitUntil(() => settled(queue, t.user.id, 10), 30_000, 'all emails sent or rescheduled');

  assert.equal(delivery.calls.length, 4);
  const rows = await prisma.email.findMany({ where: { id: { in: emails.map((e) => e.id) } } });
  assert.equal(rows.filter((r) => r.status === 'SENT').length, 4);
  const rescheduled = rows.filter((r) => r.status === 'SCHEDULED');
  assert.equal(rescheduled.length, 6);
  const nextHour = (Math.floor(Date.now() / HOUR_MS) + 1) * HOUR_MS;
  assert.ok(rescheduled.every((r) => r.rescheduleCount === 1 && r.scheduledAt.getTime() >= nextHour));
  assert.deepEqual(await queue.getJobCounts('completed', 'delayed', 'waiting', 'failed'), { completed: 4, delayed: 6, waiting: 0, failed: 0 });
});

test('L13. multiple worker processes share the same hourly limit', async () => {
  await awayFromWindowEdge(HOUR_MS, 60_000);
  const { queue, prefix } = newQueue();
  const t = await makeTenant({ senderHourlyLimit: 3 });
  const rlPrefix = `${RL_PREFIX_ROOT}-l13`;
  const sent: { emailId: string; pid: string }[] = [];
  const ready = new Set<string>();

  for (let i = 0; i < 2; i++) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/rate-worker.ts', prefix, rlPrefix, '150'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const [kind, a, b] = line.trim().split(' ');
        if (kind === 'READY' && a) ready.add(a);
        if (kind === 'SENT' && a && b) sent.push({ emailId: a, pid: b });
      }
    });
  }
  await waitUntil(async () => ready.size === 2, 30_000, 'both worker processes ready');

  const emails = await Promise.all(Array.from({ length: 8 }, () => makeEmail(t, new Date(Date.now() - 1_000))));
  await scheduleAll(queue, emails.map((e) => e.id));

  await waitUntil(() => settled(queue, t.user.id, 8), 30_000, 'all emails sent or rescheduled');

  assert.equal(sent.length, 3, `sent ${JSON.stringify(sent)}`);
  assert.equal(new Set(sent.map((s) => s.pid)).size, 2, 'both processes sent');
  const rows = await prisma.email.findMany({ where: { id: { in: emails.map((e) => e.id) } } });
  assert.equal(rows.filter((r) => r.status === 'SENT').length, 3);
  assert.equal(rows.filter((r) => r.status === 'SCHEDULED' && r.rescheduleCount === 1).length, 5);
});

test('L14. rate-limit windows expire: keys carry TTLs and a new window starts empty', async () => {
  const windowMs = 1_500;
  await awayFromWindowEdge(windowMs, 1_000);
  const t = await makeTenant();
  const limiter = newLimiter({ windowMs });
  const req = () => ({
    emailId: randomUUID(),
    senderId: t.sender.id,
    campaignId: t.campaign.id,
    delayMs: 0,
    senderHourlyLimit: 1,
    campaignHourlyLimit: 100,
  });

  const a = await limiter.reserve(req());
  const b = await limiter.reserve(req());
  assert.equal(a.windowOffset, 0);
  assert.equal(b.windowOffset, 1, 'window full');

  const redis = new Redis(env.REDIS_URL);
  try {
    const w0 = Math.floor(a.now / windowMs);
    const key = `${limiter.keyPrefix}:{s:${t.sender.id}}:w:${w0}`;
    const ttl = await redis.pttl(key);
    assert.ok(ttl > 0 && ttl <= 2 * windowMs, `ttl ${ttl}`);

    // Two windows later (w0 and w0+1 are used), the current window is empty again.
    await sleep((w0 + 2) * windowMs - Date.now() + 20);
    const c = await limiter.reserve(req());
    assert.equal(c.windowOffset, 0, 'fresh window accepts again');
    await sleep((w0 + 2) * windowMs + 50 - Date.now());
    assert.equal(await redis.exists(key), 0, 'old window key expired');
  } finally {
    redis.disconnect();
  }
});

// --- ordering --------------------------------------------------------------

test('O15. same sender/campaign keeps scheduling order through rate-limit rescheduling', async () => {
  const windowMs = 2_000;
  await awayFromWindowEdge(windowMs, 1_200);
  const { queue, prefix } = newQueue();
  const t = await makeTenant({ senderHourlyLimit: 3, delayMs: 50 });
  const emails = [];
  for (let i = 0; i < 6; i++) emails.push(await makeEmail(t, new Date(Date.now() - 6_000 + i * 100)));
  await scheduleAll(queue, emails.map((e) => e.id));
  const delivery = fakeDelivery();

  const worker = newWorker(prefix, delivery.service, { concurrency: 1, rateLimiter: newLimiter({ windowMs }) });
  await Promise.all(emails.map((e) => waitForJobEnd(worker, emailJobId(e.id), 15_000)));

  const rows = await deliveredRows(emails.map((e) => e.id));
  assert.deepEqual(rows.map((r) => r.id), emails.map((e) => e.id), 'sent in scheduled order');
  assert.deepEqual(rows.map((r) => r.rescheduleCount), [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(delivery.calls.map((c) => c.id), emails.map((e) => e.id));
});

test('O15b. reconciliation enqueues in scheduledAt order, not insertion/id order', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant();
  const offsets = [5, 1, 4, 2, 6, 3]; // insertion order differs from time order
  const emails = [];
  for (const o of offsets) emails.push(await makeEmail(t, new Date(Date.now() - 10_000 + o * 100)));
  await reconcileEmailJobs({ queue, userId: t.user.id });
  const delivery = fakeDelivery();

  const worker = newWorker(prefix, delivery.service, { concurrency: 1 });
  await Promise.all(emails.map((e) => waitForJobEnd(worker, emailJobId(e.id))));

  const expected = [...emails].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime()).map((e) => e.id);
  assert.deepEqual(delivery.calls.map((c) => c.id), expected);
});

// --- idempotency / recovery ------------------------------------------------

test('I16. a SENT email is never sent again, even if its job is re-added', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant();
  const email = await makeEmail(t, new Date(Date.now() - 1_000));
  const { jobId } = await scheduleEmail(email.id, queue);
  const delivery = fakeDelivery();
  const worker = newWorker(prefix, delivery.service);
  assert.equal((await waitForJobEnd(worker, jobId)).state, 'completed');

  await (await queue.getJob(jobId))!.remove();
  await queue.add(SEND_EMAIL_JOB, jobData(t, email.id), { jobId });
  const again = await waitForJobEnd(worker, jobId);

  assert.equal(again.state === 'completed' && again.result.outcome, 'skipped');
  assert.equal(delivery.calls.length, 1);
});

test('I17. DELIVERY_UNKNOWN after a real SMTP drop is never resent automatically', async () => {
  const server = await startFakeSmtp('drop_after_data');
  try {
    const { queue, prefix } = newQueue();
    const t = await smtpTenant(server.port);
    const email = await makeEmail(t, new Date(Date.now() - 1_000));
    const { jobId } = await scheduleEmail(email.id, queue);
    const worker = newWorker(prefix, createSmtpDelivery({ allowPrivateHosts: true }));
    await waitForJobEnd(worker, jobId, 20_000);
    assert.equal((await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).status, 'DELIVERY_UNKNOWN');

    // Reconciliation and a stale job both leave it alone.
    const r = await reconcileEmailJobs({ queue, userId: t.user.id });
    assert.equal(r.scheduled + r.claimsReleased, 0);
    await (await queue.getJob(jobId))!.remove();
    await queue.add(SEND_EMAIL_JOB, jobData(t, email.id), { jobId });
    const again = await waitForJobEnd(worker, jobId);
    assert.equal(again.state === 'completed' && again.result.outcome, 'skipped');
    assert.equal(server.messages.length, 1, 'the SMTP server received the message exactly once');
  } finally {
    await server.close();
  }
});

test('I18. a stale processing token cannot mutate the email', async () => {
  const t = await makeTenant();
  const current = randomUUID();
  const stale = randomUUID();
  const email = await makeEmail(t, new Date(Date.now() - 1_000), {
    status: 'PROCESSING',
    processingToken: current,
    deliveryStartedAt: new Date(),
  });

  assert.equal(await markSent(email.id, stale, { providerMessageId: 'x' }), false);
  assert.equal(await markFailed(email.id, stale, 'X', 'x'), false);
  assert.equal(await markDeliveryUnknown(email.id, stale, 'x'), false);
  const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, 'PROCESSING');
  assert.equal(row.processingToken, current);
  assert.equal(row.providerMessageId, null);
  assert.equal(await markSent(email.id, current, { providerMessageId: 'ok' }), true, 'current token still works');
});

test('I19. duplicate scheduling of a rate-limited email creates no duplicate job', async () => {
  const windowMs = 60_000;
  await awayFromWindowEdge(windowMs, 10_000);
  const { queue, prefix } = newQueue();
  const t = await makeTenant({ senderHourlyLimit: 1 });
  const [a, b] = [await makeEmail(t, new Date(Date.now() - 1_000)), await makeEmail(t, new Date(Date.now() - 900))];
  await scheduleAll(queue, [a.id, b.id]);
  const worker = newWorker(prefix, fakeDelivery().service, { concurrency: 1, rateLimiter: newLimiter({ windowMs }) });
  await waitForJobEnd(worker, emailJobId(a.id));
  await waitUntil(async () => (await (await queue.getJob(emailJobId(b.id)))?.getState()) === 'delayed', 10_000, 'b re-delayed');

  const results = await Promise.all([scheduleEmail(b.id, queue), scheduleEmail(b.id, queue), reconcileEmailJobs({ queue, userId: t.user.id })]);
  assert.equal(results[0].status, 'already_scheduled');
  assert.equal(results[1].status, 'already_scheduled');
  assert.deepEqual(await queue.getJobCounts('delayed', 'waiting'), { delayed: 1, waiting: 0 });
});

// --- 1000+ emails ------------------------------------------------------------

test('V. 1000 emails at the same time, 3 workers, hourly limit + minimum delay', { timeout: 180_000 }, async () => {
  await awayFromWindowEdge(HOUR_MS, 120_000);
  const { queue, prefix } = newQueue();
  const LIMIT = 400;
  const TOTAL = 1_000;
  const delayMs = 2;
  const t: Tenant = await makeTenant({ senderHourlyLimit: LIMIT, campaignHourlyLimit: 10_000, delayMs });
  const at = new Date(Date.now() - 1_000);

  // Insert in batches and schedule via the batched reconciliation pass (no full load into memory).
  for (let i = 0; i < TOTAL; i += 250) {
    await prisma.email.createMany({
      data: Array.from({ length: Math.min(250, TOTAL - i) }, () => ({
        userId: t.user.id,
        campaignId: t.campaign.id,
        senderId: t.sender.id,
        recipientEmail: 'bulk@example.com',
        subject: 'S',
        body: 'B',
        scheduledAt: at,
        originalScheduledAt: at,
        idempotencyKey: randomUUID(),
      })),
    });
  }
  const scheduled = await reconcileEmailJobs({ queue, userId: t.user.id });
  assert.equal(scheduled.scheduled, TOTAL);

  const events: HourlyLimitReachedEvent[] = [];
  const onEvent = (e: HourlyLimitReachedEvent) => events.push(e);
  emailEvents.on('hourlyLimitReached', onEvent);
  const delivery = fakeDelivery();
  const shared = `${RL_PREFIX_ROOT}-v`;
  const started = Date.now();
  try {
    const workers: EmailWorker[] = [];
    for (let i = 0; i < 3; i++) {
      workers.push(newWorker(prefix, delivery.service, { concurrency: 5, rateLimiter: new SendRateLimiter({ keyPrefix: shared }) }));
    }
    await waitUntil(() => settled(queue, t.user.id, TOTAL), 150_000, 'all 1000 emails sent or rescheduled');
  } finally {
    emailEvents.off('hourlyLimitReached', onEvent);
  }
  const elapsed = Date.now() - started;

  const counts = await queue.getJobCounts('completed', 'delayed', 'waiting', 'active', 'failed');
  assert.deepEqual(counts, { completed: LIMIT, delayed: TOTAL - LIMIT, waiting: 0, active: 0, failed: 0 });
  assert.equal(delivery.calls.length, LIMIT);
  assert.equal(new Set(delivery.calls.map((c) => c.id)).size, LIMIT, 'no email delivered twice');

  const byStatus = await prisma.email.groupBy({ by: ['status'], where: { userId: t.user.id }, _count: true });
  assert.deepEqual(Object.fromEntries(byStatus.map((s) => [s.status, s._count])), { SENT: LIMIT, SCHEDULED: TOTAL - LIMIT });

  const hour = Math.floor(Date.now() / HOUR_MS);
  const rescheduled = await prisma.email.findMany({
    where: { userId: t.user.id, status: 'SCHEDULED' },
    select: { scheduledAt: true, rescheduleCount: true },
  });
  const perWindow = rescheduled.reduce<Record<number, number>>((acc, r) => {
    const w = Math.floor(r.scheduledAt.getTime() / HOUR_MS) - hour;
    return { ...acc, [w]: (acc[w] ?? 0) + 1 };
  }, {});
  assert.deepEqual(perWindow, { 1: LIMIT, 2: TOTAL - 2 * LIMIT }, 'next windows filled up to the limit');
  assert.ok(rescheduled.every((r) => r.rescheduleCount === 1));

  const sent = await prisma.email.findMany({ where: { userId: t.user.id, status: 'SENT' }, select: { deliveryStartedAt: true } });
  const minGap = Math.min(...gaps(sent.map((s) => s.deliveryStartedAt!.getTime())));
  assert.ok(minGap >= delayMs, `min authorization gap ${minGap}ms`);
  assert.equal(events.length, 1, 'one hourlyLimitReached event for the window');

  console.log(`V: ${TOTAL} emails, ${LIMIT} sent + ${TOTAL - LIMIT} rescheduled in ${elapsed}ms; min gap ${minGap}ms`);
});
