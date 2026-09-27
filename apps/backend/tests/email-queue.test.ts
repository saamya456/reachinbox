// Integration tests for the BullMQ scheduling foundation (Phase 3), run
// against the real Redis and PostgreSQL containers. Shared helpers and
// isolation are in helpers.ts.
import './setup.js';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { env } from '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import { getRedisConnection } from '../src/queue/connection.js';
import { EMAIL_QUEUE_NAME, emailJobId, SEND_EMAIL_JOB } from '../src/queue/email.queue.js';
import { startEmailWorker } from '../src/queue/start-worker.js';
import { DeliveryRejectedError } from '../src/services/email-delivery.service.js';
import { processEmail, recoverInterruptedClaim } from '../src/services/email-processing.service.js';
import {
  EmailNotSchedulableError,
  reconcileEmailJobs,
  scheduleEmail,
} from '../src/services/email-scheduler.service.js';
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
  trackWorker,
  waitForJobEnd,
} from './helpers.js';

after(cleanup);

test('A. queue connects to Redis', async () => {
  const { queue } = newQueue();
  assert.equal(await getRedisConnection().ping(), 'PONG');
  await queue.waitUntilReady();
  assert.deepEqual(await queue.getJobCounts('waiting', 'delayed'), { waiting: 0, delayed: 0 });
});

test('B+C. future email becomes a delayed job with the correct ids and no secrets', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant();
  const scheduledAt = new Date(Date.now() + 30 * 60_000);
  const email = await makeEmail(t, scheduledAt);

  const result = await scheduleEmail(email.id, queue);
  assert.equal(result.status, 'scheduled');
  assert.equal(result.jobId, `email-${email.id}`);
  assert.ok(result.delayMs > 29 * 60_000 && result.delayMs <= 30 * 60_000, `delay ${result.delayMs}`);

  const job = await queue.getJob(result.jobId);
  assert.ok(job);
  assert.equal(await job.getState(), 'delayed');
  assert.equal(job.name, SEND_EMAIL_JOB);
  assert.deepEqual(job.data, jobData(t, email.id));
  assert.equal(job.opts.attempts, 3);
  assert.deepEqual(job.opts.backoff, { type: 'exponential', delay: 5_000 });
  assert.ok(Math.abs(job.timestamp + job.delay - scheduledAt.getTime()) < 1_000, 'runs at scheduledAt');

  // Inspect Redis directly: the job hash and the delayed sorted set.
  const redis = getRedisConnection();
  const key = `${prefix}:${EMAIL_QUEUE_NAME}`;
  assert.notEqual(await redis.zscore(`${key}:delayed`, result.jobId), null);
  const raw = await redis.hgetall(`${key}:${result.jobId}`);
  assert.deepEqual(Object.keys(JSON.parse(raw.data!)).sort(), ['campaignId', 'emailId', 'senderId', 'userId']);
  assert.doesNotMatch(JSON.stringify(raw), /password|smtp|token/i);
});

test('D. scheduling the same email repeatedly creates one job', async () => {
  const { queue } = newQueue();
  const t = await makeTenant();
  const email = await makeEmail(t, new Date(Date.now() + 60 * 60_000));

  const first = await scheduleEmail(email.id, queue);
  const again = await scheduleEmail(email.id, queue);
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => scheduleEmail(email.id, queue)));
  // Even a raw add with the same deterministic id is ignored by BullMQ.
  await queue.add(SEND_EMAIL_JOB, jobData(t, email.id), { jobId: emailJobId(email.id), delay: 1 });

  assert.equal(first.status, 'scheduled');
  assert.equal(again.status, 'already_scheduled');
  assert.ok(concurrent.every((r) => r.jobId === first.jobId));
  assert.deepEqual(await queue.getJobCounts('delayed', 'waiting'), { delayed: 1, waiting: 0 });
  const delayed = await queue.getDelayed();
  assert.deepEqual(delayed.map((j) => j.id), [first.jobId]);
});

test('E. past scheduledAt produces an immediately eligible job', async () => {
  const { queue } = newQueue();
  const t = await makeTenant();
  const email = await makeEmail(t, new Date(Date.now() - 5 * 60_000));

  const result = await scheduleEmail(email.id, queue);
  assert.equal(result.delayMs, 0);
  const job = await queue.getJob(result.jobId);
  assert.equal(await job!.getState(), 'waiting');
});

test('F+G. worker receives the job, loads the email, claims it and records the result', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant();
  const email = await makeEmail(t, new Date(Date.now() - 1_000));
  const { jobId } = await scheduleEmail(email.id, queue);
  const delivery = fakeDelivery();

  const worker = newWorker(prefix, delivery.service);
  const end = await waitForJobEnd(worker, jobId);

  assert.equal(end.state, 'completed');
  assert.deepEqual(end.state === 'completed' && end.result, {
    outcome: 'delivered',
    emailId: email.id,
    providerMessageId: `<fake-${email.id}@test>`,
  });
  assert.equal(delivery.calls.length, 1);
  assert.equal(delivery.calls[0]!.recipientEmail, 'rcpt@example.com');
  assert.equal(delivery.calls[0]!.idempotencyKey, email.idempotencyKey);
  assert.ok(!('smtpPasswordEncrypted' in delivery.calls[0]!));

  const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, 'SENT');
  assert.equal(row.attempts, 1);
  assert.ok(row.sentAt && row.lastAttemptAt);
  assert.equal(row.providerMessageId, `<fake-${email.id}@test>`);
  assert.ok(row.processingToken && row.deliveryStartedAt, 'claim token and delivery marker recorded');
});

test('H. worker skips terminal, missing and mismatched emails without delivering', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant();
  const other = await makeTenant();
  const sent = await makeEmail(t, new Date(Date.now() - 1_000), { status: 'SENT', sentAt: new Date() });
  const cancelled = await makeEmail(t, new Date(Date.now() - 1_000), { status: 'CANCELLED' });
  const valid = await makeEmail(t, new Date(Date.now() - 1_000));

  await assert.rejects(scheduleEmail(sent.id, queue), EmailNotSchedulableError);
  await assert.rejects(scheduleEmail(cancelled.id, queue), EmailNotSchedulableError);

  // Bypass the scheduler to simulate stale jobs for emails that changed state.
  const missingId = randomUUID();
  await queue.add(SEND_EMAIL_JOB, jobData(t, sent.id), { jobId: emailJobId(sent.id) });
  await queue.add(SEND_EMAIL_JOB, jobData(t, cancelled.id), { jobId: emailJobId(cancelled.id) });
  await queue.add(SEND_EMAIL_JOB, jobData(t, missingId), { jobId: emailJobId(missingId) });
  // Job claims the email belongs to another tenant's campaign.
  await queue.add(
    SEND_EMAIL_JOB,
    { ...jobData(t, valid.id), campaignId: other.campaign.id },
    { jobId: emailJobId(valid.id) },
  );

  const delivery = fakeDelivery();
  const worker = newWorker(prefix, delivery.service);
  const [endSent, endCancelled, endMissing, endMismatch] = await Promise.all([
    waitForJobEnd(worker, emailJobId(sent.id)),
    waitForJobEnd(worker, emailJobId(cancelled.id)),
    waitForJobEnd(worker, emailJobId(missingId)),
    waitForJobEnd(worker, emailJobId(valid.id)),
  ]);

  assert.deepEqual(endSent.state === 'completed' && endSent.result, {
    outcome: 'skipped', emailId: sent.id, reason: 'already_terminal', status: 'SENT',
  });
  assert.deepEqual(endCancelled.state === 'completed' && endCancelled.result, {
    outcome: 'skipped', emailId: cancelled.id, reason: 'already_terminal', status: 'CANCELLED',
  });
  assert.deepEqual(endMissing.state === 'completed' && endMissing.result, {
    outcome: 'skipped', emailId: missingId, reason: 'not_found',
  });
  assert.equal(endMismatch.state, 'failed');
  assert.match(endMismatch.state === 'failed' ? endMismatch.error.message : '', /does not match/);
  assert.equal(endMismatch.job?.attemptsMade, 1, 'unrecoverable: not retried');

  assert.equal(delivery.calls.length, 0);
  const rows = await prisma.email.findMany({ where: { id: { in: [sent.id, cancelled.id, valid.id] } } });
  assert.ok(rows.every((r) => r.attempts === 0));
  assert.equal(rows.find((r) => r.id === valid.id)!.status, 'SCHEDULED');
});

test('H2. concurrent processing of one email delivers it once (atomic claim)', async () => {
  const t = await makeTenant();
  const email = await makeEmail(t, new Date(Date.now() - 1_000));
  const delivery = fakeDelivery(() => sleep(200));
  const rateLimiter = newLimiter();

  const results = await Promise.all([
    processEmail(jobData(t, email.id), { delivery: delivery.service, rateLimiter }),
    processEmail(jobData(t, email.id), { delivery: delivery.service, rateLimiter }),
    processEmail(jobData(t, email.id), { delivery: delivery.service, rateLimiter }),
  ]);

  assert.equal(delivery.calls.length, 1);
  assert.equal(results.filter((r) => r.outcome === 'delivered').length, 1);
  assert.equal(results.filter((r) => r.outcome === 'skipped').length, 2);
  const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, 'SENT');
  assert.equal(row.attempts, 1);
});

test('H3. ambiguous delivery errors mark DELIVERY_UNKNOWN and are not retried', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant();
  const email = await makeEmail(t, new Date(Date.now() - 1_000));
  const { jobId } = await scheduleEmail(email.id, queue);
  const delivery = fakeDelivery(async () => {
    throw new Error('connection reset after DATA');
  });

  const worker = newWorker(prefix, delivery.service);
  const end = await waitForJobEnd(worker, jobId);

  assert.equal(end.state, 'failed');
  assert.equal(end.job?.attemptsMade, 1);
  assert.equal(delivery.calls.length, 1);
  const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, 'DELIVERY_UNKNOWN');
  assert.equal(row.errorCode, 'DELIVERY_OUTCOME_UNKNOWN');
  assert.ok(row.deliveryStartedAt);
  assert.match(row.errorMessage ?? '', /connection reset/);
  await assert.rejects(scheduleEmail(email.id, queue), EmailNotSchedulableError);
});

test('H3b. definitive rejections (DeliveryRejectedError) mark FAILED and are not retried', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant();
  const email = await makeEmail(t, new Date(Date.now() - 1_000));
  const { jobId } = await scheduleEmail(email.id, queue);
  const delivery = fakeDelivery(async () => {
    throw new DeliveryRejectedError('550 mailbox unavailable', 'SMTP_550');
  });

  const worker = newWorker(prefix, delivery.service);
  const end = await waitForJobEnd(worker, jobId);

  assert.equal(end.state, 'failed');
  assert.equal(end.job?.attemptsMade, 1);
  const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, 'FAILED');
  assert.equal(row.errorCode, 'SMTP_550');
});

test('I. WORKER_CONCURRENCY is applied and bounds parallel jobs', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant();
  assert.equal(env.WORKER_CONCURRENCY, 3);

  let inFlight = 0;
  let maxInFlight = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reachedLimit!: () => void;
  const limitReached = new Promise<void>((r) => (reachedLimit = r));
  const delivery = fakeDelivery(async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (inFlight === 3) reachedLimit();
    await gate;
    inFlight--;
  });

  const emails = await Promise.all(Array.from({ length: 6 }, () => makeEmail(t, new Date(Date.now() - 1_000))));
  for (const e of emails) await scheduleEmail(e.id, queue);

  const worker = newWorker(prefix, delivery.service); // no explicit concurrency
  assert.equal(worker.concurrency, 3);
  const ends = Promise.all(emails.map((e) => waitForJobEnd(worker, emailJobId(e.id))));

  await limitReached;
  await sleep(500); // give a 4th job the chance to start if the limit were not applied
  assert.equal(maxInFlight, 3);
  assert.equal(delivery.calls.length, 3);
  release();

  const results = await ends;
  assert.ok(results.every((r) => r.state === 'completed'));
  assert.equal(delivery.calls.length, 6);
  assert.equal(maxInFlight, 3);
});

test('J. delayed job survives a worker restart and runs at scheduledAt', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant();
  const scheduledAt = new Date(Date.now() + 4_000);
  const email = await makeEmail(t, scheduledAt);
  const { jobId } = await scheduleEmail(email.id, queue);
  const delivery = fakeDelivery();

  const first = newWorker(prefix, delivery.service);
  await first.waitUntilReady();
  await first.close();

  // Check with an independent Redis client that the job is still delayed.
  const inspector = new Redis(env.REDIS_URL);
  try {
    assert.notEqual(await inspector.zscore(`${prefix}:${EMAIL_QUEUE_NAME}:delayed`, jobId), null);
  } finally {
    inspector.disconnect();
  }
  assert.equal(await (await queue.getJob(jobId))!.getState(), 'delayed');
  assert.equal(delivery.calls.length, 0);

  const second = newWorker(prefix, delivery.service);
  const end = await waitForJobEnd(second, jobId);

  assert.equal(end.state, 'completed');
  assert.equal(delivery.calls.length, 1);
  const processedOn = end.job?.processedOn ?? 0;
  assert.ok(processedOn >= scheduledAt.getTime() - 50, `processed ${scheduledAt.getTime() - processedOn}ms early`);
  assert.ok(processedOn - scheduledAt.getTime() < 3_000, `processed ${processedOn - scheduledAt.getTime()}ms late`);
});

test('K. job fired before the persisted scheduledAt is re-delayed, not processed', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant();
  const email = await makeEmail(t, new Date(Date.now() - 1_000));
  const { jobId } = await scheduleEmail(email.id, queue);
  // The row moves later after the job was queued; the row is the source of truth.
  const newScheduledAt = new Date(Date.now() + 3_000);
  await prisma.email.update({ where: { id: email.id }, data: { scheduledAt: newScheduledAt } });
  const delivery = fakeDelivery();

  const worker = newWorker(prefix, delivery.service);
  const end = await waitForJobEnd(worker, jobId);

  assert.equal(end.state, 'completed');
  assert.equal(delivery.calls.length, 1);
  assert.ok((end.job?.processedOn ?? 0) >= newScheduledAt.getTime() - 1_000);
  assert.deepEqual(
    (await queue.getJobCounts('completed', 'delayed', 'waiting')),
    { completed: 1, delayed: 0, waiting: 0 },
    'same job reused, no duplicate',
  );
});

// ---------------------------------------------------------------------------
// Startup reconciliation
// ---------------------------------------------------------------------------

test('R1. startup reconciliation creates a missing job, then processing starts', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant();
  // Simulates "row committed, BullMQ add failed": a due email with no job.
  const email = await makeEmail(t, new Date(Date.now() - 1_000));
  assert.equal(await queue.getJob(emailJobId(email.id)), undefined);
  const delivery = fakeDelivery();

  const started = await startEmailWorker({
    queue,
    prefix,
    userId: t.user.id,
    delivery: delivery.service,
    rateLimiter: newLimiter(),
  });
  trackWorker(started.worker);
  const end = await waitForJobEnd(started.worker, emailJobId(email.id));

  assert.deepEqual(started.reconciliation, {
    claimsReleased: 0,
    claimsDeliveryUnknown: 0,
    claimsInFlight: 0,
    scheduled: 1,
    alreadyScheduled: 0,
  });
  assert.equal(end.state, 'completed');
  assert.equal(delivery.calls.length, 1);
  assert.ok((end.job?.processedOn ?? 0) >= started.processingStartedAt.getTime(), 'processed only after reconciliation');
});

test('R2. reconciliation twice (and concurrently) creates no duplicate jobs', async () => {
  const { queue } = newQueue();
  const t = await makeTenant();
  const future = await makeEmail(t, new Date(Date.now() + 60 * 60_000));
  const due = await makeEmail(t, new Date(Date.now() - 60_000));

  const first = await reconcileEmailJobs({ queue, userId: t.user.id });
  const second = await reconcileEmailJobs({ queue, userId: t.user.id });
  await Promise.all([
    reconcileEmailJobs({ queue, userId: t.user.id }),
    reconcileEmailJobs({ queue, userId: t.user.id }),
  ]);

  assert.equal(first.scheduled, 2);
  assert.equal(second.scheduled, 0);
  assert.equal(second.alreadyScheduled, 2);
  assert.deepEqual(await queue.getJobCounts('delayed', 'waiting'), { delayed: 1, waiting: 1 });
  const ids = [...(await queue.getDelayed()), ...(await queue.getWaiting())].map((j) => j.id).sort();
  assert.deepEqual(ids, [emailJobId(future.id), emailJobId(due.id)].sort());
});

test('R3. a scheduled email whose job was lost is recovered with its persisted delay', async () => {
  const { queue } = newQueue();
  const t = await makeTenant();
  const scheduledAt = new Date(Date.now() + 10 * 60_000);
  const email = await makeEmail(t, scheduledAt);
  const { jobId } = await scheduleEmail(email.id, queue);
  // Simulate Redis losing the job.
  await (await queue.getJob(jobId))!.remove();
  assert.equal(await queue.getJob(jobId), undefined);

  const result = await reconcileEmailJobs({ queue, userId: t.user.id });

  assert.equal(result.scheduled, 1);
  const job = await queue.getJob(jobId);
  assert.equal(await job!.getState(), 'delayed');
  assert.ok(Math.abs(job!.timestamp + job!.delay - scheduledAt.getTime()) < 1_000, 'runs at persisted scheduledAt');
  assert.deepEqual(job!.data, jobData(t, email.id));
});

// ---------------------------------------------------------------------------
// PROCESSING / crash recovery
// ---------------------------------------------------------------------------

test('P1. orphaned claim where delivery never started is released and delivered once', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant();
  // Crash between claim and delivery: PROCESSING, token set, deliveryStartedAt null, no job.
  const email = await makeEmail(t, new Date(Date.now() - 60_000), {
    status: 'PROCESSING',
    processingToken: randomUUID(),
    attempts: 1,
    lastAttemptAt: new Date(),
  });
  const delivery = fakeDelivery();

  const started = await startEmailWorker({
    queue,
    prefix,
    userId: t.user.id,
    delivery: delivery.service,
    rateLimiter: newLimiter(),
  });
  trackWorker(started.worker);
  const end = await waitForJobEnd(started.worker, emailJobId(email.id));

  assert.equal(started.reconciliation?.claimsReleased, 1);
  assert.equal(started.reconciliation?.scheduled, 1);
  assert.equal(end.state, 'completed');
  assert.equal(delivery.calls.length, 1);
  const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, 'SENT');
  assert.equal(row.attempts, 2, 'crashed claim + successful claim');
});

test('P2. orphaned claim where delivery started becomes DELIVERY_UNKNOWN and is never re-sent', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant();
  // Crash after the provider may have accepted it: deliveryStartedAt set, no job.
  const email = await makeEmail(t, new Date(Date.now() - 60_000), {
    status: 'PROCESSING',
    processingToken: randomUUID(),
    deliveryStartedAt: new Date(),
    attempts: 1,
  });
  const delivery = fakeDelivery();

  const started = await startEmailWorker({
    queue,
    prefix,
    userId: t.user.id,
    delivery: delivery.service,
    rateLimiter: newLimiter(),
  });
  trackWorker(started.worker);

  assert.equal(started.reconciliation?.claimsDeliveryUnknown, 1);
  assert.equal(started.reconciliation?.scheduled, 0);
  assert.equal(await queue.getJob(emailJobId(email.id)), undefined, 'no job created');
  const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, 'DELIVERY_UNKNOWN');
  assert.equal(row.errorCode, 'DELIVERY_OUTCOME_UNKNOWN');
  await assert.rejects(scheduleEmail(email.id, queue), EmailNotSchedulableError);

  // Even a stale job for it is skipped without delivering.
  await queue.add(SEND_EMAIL_JOB, jobData(t, email.id), { jobId: emailJobId(email.id) });
  const end = await waitForJobEnd(started.worker, emailJobId(email.id));
  assert.equal(end.state === 'completed' && end.result.outcome, 'skipped');
  assert.equal(delivery.calls.length, 0);
  // A second reconciliation changes nothing.
  const again = await reconcileEmailJobs({ queue, userId: t.user.id });
  assert.equal(again.claimsDeliveryUnknown + again.claimsReleased + again.scheduled, 0);
});

test('P3. a PROCESSING row is only recovered with evidence of an interrupted run', async () => {
  const t = await makeTenant();
  const notStarted = await makeEmail(t, new Date(Date.now() - 1_000), {
    status: 'PROCESSING',
    processingToken: randomUUID(),
  });
  const started = await makeEmail(t, new Date(Date.now() - 1_000), {
    status: 'PROCESSING',
    processingToken: randomUUID(),
    deliveryStartedAt: new Date(),
  });
  const delivery = fakeDelivery();
  const rateLimiter = newLimiter();

  // First activation of a job: the claim belongs to someone else, so it is untouched.
  const firstRun = await processEmail(jobData(t, notStarted.id), { delivery: delivery.service, rateLimiter }, { isRerun: false });
  assert.equal(firstRun.outcome === 'skipped' && firstRun.reason, 'already_processing');
  assert.equal((await prisma.email.findUniqueOrThrow({ where: { id: notStarted.id } })).status, 'PROCESSING');

  // Re-run of the same job (retry/stall): recover.
  const rerunReleased = await processEmail(jobData(t, notStarted.id), { delivery: delivery.service, rateLimiter }, { isRerun: true });
  assert.equal(rerunReleased.outcome, 'delivered');
  const rerunUnknown = await processEmail(jobData(t, started.id), { delivery: delivery.service, rateLimiter }, { isRerun: true });
  assert.equal(rerunUnknown.outcome === 'skipped' && rerunUnknown.reason, 'delivery_unknown');

  assert.deepEqual(delivery.calls.map((c) => c.id), [notStarted.id]);
  assert.equal((await prisma.email.findUniqueOrThrow({ where: { id: started.id } })).status, 'DELIVERY_UNKNOWN');
});

test('P4. reconciliation leaves a claim held by a live worker alone', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant();
  const email = await makeEmail(t, new Date(Date.now() - 1_000));
  const { jobId } = await scheduleEmail(email.id, queue);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inDelivery = new Promise<void>((r) => (entered = r));
  const delivery = fakeDelivery(async () => {
    entered();
    await gate;
  });

  const worker = newWorker(prefix, delivery.service);
  const end = waitForJobEnd(worker, jobId);
  await inDelivery;
  const before = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });

  const result = await reconcileEmailJobs({ queue, userId: t.user.id });

  assert.equal(result.claimsInFlight, 1);
  assert.equal(result.claimsReleased + result.claimsDeliveryUnknown, 0);
  const during = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(during.status, 'PROCESSING');
  assert.equal(during.processingToken, before.processingToken);
  release();
  assert.equal((await end).state, 'completed');
  assert.equal((await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).status, 'SENT');
  assert.equal(delivery.calls.length, 1);
});

test('P5. recovery with a stale claim token is a no-op', async () => {
  const t = await makeTenant();
  const token = randomUUID();
  const email = await makeEmail(t, new Date(Date.now() - 1_000), { status: 'PROCESSING', processingToken: token });

  assert.equal(await recoverInterruptedClaim(email.id, randomUUID()), 'noop');
  assert.equal(await recoverInterruptedClaim(email.id, null), 'noop');
  const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, 'PROCESSING');
  assert.equal(row.processingToken, token);
});

test('P6. real worker crash mid-delivery: stalled job re-runs, email becomes DELIVERY_UNKNOWN, not re-sent', async () => {
  const { queue, prefix } = newQueue();
  const t = await makeTenant();
  const email = await makeEmail(t, new Date(Date.now() - 1_000));
  const { jobId } = await scheduleEmail(email.id, queue);

  // A separate worker process that hangs inside delivery; kill it there.
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/crash-worker.ts', prefix, `${RL_PREFIX_ROOT}-crash`], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child never reached delivery')), 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes(`DELIVERY_STARTED ${email.id}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  child.kill('SIGKILL');
  await exited;

  const orphaned = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(orphaned.status, 'PROCESSING');
  assert.ok(orphaned.deliveryStartedAt, 'delivery had started when the process died');
  assert.equal(await (await queue.getJob(jobId))!.getState(), 'active', 'lock still held by the dead worker');

  // A new worker: BullMQ's stalled-job check re-queues the job once the dead
  // worker's lock expires, and the re-run must not deliver again.
  const delivery = fakeDelivery();
  const worker = newWorker(prefix, delivery.service, { stalled: { lockDuration: 1_000, stalledInterval: 500 } });
  const end = await waitForJobEnd(worker, jobId, 20_000);

  assert.equal(end.state, 'completed');
  assert.deepEqual(end.state === 'completed' && end.result, {
    outcome: 'skipped',
    emailId: email.id,
    reason: 'delivery_unknown',
    status: 'DELIVERY_UNKNOWN',
  });
  assert.equal(end.job?.attemptsStarted, 2, 'second activation of the same job');
  assert.equal(delivery.calls.length, 0);
  const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(row.status, 'DELIVERY_UNKNOWN');
  assert.equal(row.attempts, 1);
  assert.equal(row.sentAt, null);
});
