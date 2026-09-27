// Verifies database constraints against the live PostgreSQL instance.
// Creates throwaway users (and their data) and removes them on exit.
// Run: npm run db:verify -w apps/backend
import { randomUUID } from 'node:crypto';
import { publicSenderSelect } from '../src/db/selects.js';
import { decryptSecret, encryptSecret } from '../src/lib/crypto.js';
import { prisma } from '../src/lib/prisma.js';

let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function expectReject(name: string, fn: () => Promise<unknown>, pattern: RegExp) {
  try {
    await fn();
    check(name, false, 'operation unexpectedly succeeded');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code ?? '';
    const matched = pattern.test(`${code} ${message}`);
    check(name, matched, matched ? code || 'rejected' : message.split('\n').slice(-3).join(' '));
  }
}

const run = randomUUID().slice(0, 8);
const userIds: string[] = [];
// Emails created here, for cleaning up their search-outbox rows at the end.
const emailIds = new Set<string>();

async function makeTenant(label: string) {
  const user = await prisma.user.create({
    data: { googleId: `google-${label}-${run}`, email: `${label}-${run}@example.com`, name: label },
  });
  userIds.push(user.id);
  const sender = await prisma.sender.create({
    data: {
      userId: user.id,
      email: `sender-${label}-${run}@ethereal.email`,
      smtpHost: 'smtp.ethereal.email',
      smtpPort: 587,
      smtpUser: `sender-${label}-${run}@ethereal.email`,
      smtpPasswordEncrypted: encryptSecret('super-secret-password'),
      hourlyLimit: 50,
    },
  });
  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      subject: 'Hello',
      body: 'Body',
      startAt: new Date(),
      delayBetweenEmailsMs: 2000,
      hourlyLimit: 100,
    },
  });
  return { user, sender, campaign };
}

function emailData(userId: string, campaignId: string, senderId: string, key: string = randomUUID()) {
  const at = new Date(Date.now() + 60_000);
  return {
    userId,
    campaignId,
    senderId,
    recipientEmail: 'rcpt@example.com',
    subject: 'Hello',
    body: 'Body',
    scheduledAt: at,
    originalScheduledAt: at,
    idempotencyKey: key,
  };
}

async function main() {
  const a = await makeTenant('a');
  const b = await makeTenant('b');

  const email = await prisma.email.create({ data: emailData(a.user.id, a.campaign.id, a.sender.id) });
  check('valid email for own campaign + sender inserts', email.status === 'SCHEDULED');

  await expectReject(
    'tenant isolation: email -> other tenant campaign rejected',
    () => prisma.email.create({ data: emailData(a.user.id, b.campaign.id, a.sender.id) }),
    /P2003|foreign key/i,
  );
  await expectReject(
    'tenant isolation: email -> other tenant sender rejected',
    () => prisma.email.create({ data: emailData(a.user.id, a.campaign.id, b.sender.id) }),
    /P2003|foreign key/i,
  );
  await expectReject(
    'unique: duplicate idempotency key rejected',
    () => prisma.email.create({ data: emailData(a.user.id, a.campaign.id, a.sender.id, email.idempotencyKey) }),
    /P2002|unique/i,
  );
  await expectReject(
    'unique: duplicate sender email per user rejected',
    () =>
      prisma.sender.create({
        data: {
          userId: a.user.id,
          email: a.sender.email,
          smtpHost: 'x',
          smtpPort: 587,
          smtpUser: 'x',
          smtpPasswordEncrypted: 'x',
          hourlyLimit: 1,
        },
      }),
    /P2002|unique/i,
  );
  const sameAddressOtherTenant = await prisma.sender.create({
    data: {
      userId: b.user.id,
      email: a.sender.email,
      smtpHost: 'x',
      smtpPort: 587,
      smtpUser: 'x',
      smtpPasswordEncrypted: 'x',
      hourlyLimit: 1,
    },
  });
  check('same sender address allowed for a different tenant', !!sameAddressOtherTenant.id);

  await expectReject(
    'check: sender hourly_limit must be > 0',
    () => prisma.sender.update({ where: { id: a.sender.id }, data: { hourlyLimit: 0 } }),
    /check constraint|senders_hourly_limit_positive/i,
  );
  await expectReject(
    'check: campaign delay must be >= 0',
    () => prisma.campaign.update({ where: { id: a.campaign.id }, data: { delayBetweenEmailsMs: -1 } }),
    /check constraint|campaigns_delay_non_negative/i,
  );
  await expectReject(
    'check: SENT email requires sent_at',
    () => prisma.email.update({ where: { id: email.id }, data: { status: 'SENT' } }),
    /check constraint|emails_sent_requires_sent_at/i,
  );
  const sent = await prisma.email.update({
    where: { id: email.id },
    data: { status: 'SENT', sentAt: new Date(), attempts: 1, providerMessageId: '<msg@ethereal>' },
  });
  check('SENT email with sent_at accepted', sent.status === 'SENT');

  const later = new Date(Date.now() + 3_600_000);
  const rescheduled = await prisma.email.create({ data: emailData(a.user.id, a.campaign.id, a.sender.id) });
  const moved = await prisma.email.update({
    where: { id: rescheduled.id },
    data: { scheduledAt: later, rescheduleCount: { increment: 1 }, lastRescheduledAt: new Date() },
  });
  check(
    'rate-limit reschedule keeps original_scheduled_at',
    moved.rescheduleCount === 1 &&
      moved.originalScheduledAt.getTime() === rescheduled.originalScheduledAt.getTime() &&
      moved.scheduledAt.getTime() === later.getTime(),
  );

  const stored = await prisma.sender.findUniqueOrThrow({ where: { id: a.sender.id } });
  check('SMTP password stored as ciphertext', !stored.smtpPasswordEncrypted.includes('super-secret-password'));
  check('SMTP password decrypts', decryptSecret(stored.smtpPasswordEncrypted) === 'super-secret-password');
  const exposed = await prisma.sender.findUniqueOrThrow({ where: { id: a.sender.id }, select: publicSenderSelect });
  check('publicSenderSelect omits smtpPasswordEncrypted', !('smtpPasswordEncrypted' in exposed));

  await expectReject(
    'restrict: sender with emails cannot be deleted',
    () => prisma.sender.delete({ where: { id: a.sender.id } }),
    /P2003|foreign key|restrict/i,
  );

  const plan = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    // The real query orders by scheduled_at with a LIMIT: an ordered index scan,
    // not a bitmap scan over an unrelated index (planner choice on small data).
    await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
    return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN SELECT id FROM emails WHERE status = 'SCHEDULED' AND scheduled_at <= now() ORDER BY scheduled_at LIMIT 100`,
    );
  });
  const planText = plan.map((r) => r['QUERY PLAN']).join(' ');
  check(
    'due-email query can use emails_status_scheduled_at_idx',
    planText.includes('emails_status_scheduled_at_idx'),
    planText.includes('emails_status_scheduled_at_idx') ? '' : planText,
  );

  // Realistic sender history (5,000 sent emails over ~5 weeks) so the planner
  // chooses by selectivity instead of by table size.
  const now = Date.now();
  await prisma.email.createMany({
    data: Array.from({ length: 5000 }, (_, i) => {
      const at = new Date(now - i * 10 * 60_000);
      return {
        ...emailData(a.user.id, a.campaign.id, a.sender.id),
        status: 'SENT' as const,
        scheduledAt: at,
        originalScheduledAt: at,
        sentAt: at,
      };
    }),
  });
  await prisma.$executeRawUnsafe('ANALYZE emails');

  const hourlyPlan = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN SELECT count(*) FROM emails WHERE sender_id = '${a.sender.id}' AND sent_at >= now() - interval '1 hour'`,
    );
  });
  const hourlyText = hourlyPlan.map((r) => r['QUERY PLAN']).join(' ');
  check(
    'sender hourly-count query can use emails_sender_id_sent_at_idx',
    hourlyText.includes('emails_sender_id_sent_at_idx'),
    hourlyText.includes('emails_sender_id_sent_at_idx') ? '' : hourlyText,
  );

  for (const e of await prisma.email.findMany({ where: { userId: a.user.id }, select: { id: true } })) emailIds.add(e.id);
  await prisma.user.delete({ where: { id: a.user.id } });
  const leftover = await Promise.all([
    prisma.email.count({ where: { userId: a.user.id } }),
    prisma.campaign.count({ where: { userId: a.user.id } }),
    prisma.sender.count({ where: { userId: a.user.id } }),
  ]);
  check('cascade: deleting a user removes its emails/campaigns/senders', leftover.every((n) => n === 0), leftover.join('/'));
}

main()
  .catch((err) => {
    failures++;
    console.error(err);
  })
  .finally(async () => {
    // The search-outbox triggers record every insert/delete of these throwaway
    // emails; remove those rows too so the check leaves nothing behind.
    for (const e of await prisma.email.findMany({ where: { userId: { in: userIds } }, select: { id: true } })) emailIds.add(e.id);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    const ids = [...emailIds];
    for (let i = 0; i < ids.length; i += 5_000) {
      await prisma.searchOutbox.deleteMany({ where: { emailId: { in: ids.slice(i, i + 5_000) } } });
    }
    await prisma.$disconnect();
    console.log(failures === 0 ? '\nAll database checks passed.' : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  });
