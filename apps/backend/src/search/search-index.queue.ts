import type { Client } from '@elastic/elasticsearch';
import { Queue, UnrecoverableError, Worker, type DefaultJobOptions } from 'bullmq';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getRedisConnection } from '../queue/connection.js';
import type { QueueScope } from '../queue/email.queue.js';
import {
  bulkApply,
  emailDocumentSelect,
  ensureEmailIndex,
  getElasticsearchClient,
  toEmailDocument,
  type IndexOperation,
} from './elasticsearch.js';

// BullMQ queue that applies search_outbox rows to Elasticsearch.
//
// A job carries outbox row ids only. The worker loads the CURRENT email state
// from PostgreSQL (not a snapshot from the event), indexes it with its
// search_version as external version in one bulk request, and deletes exactly
// the outbox rows Elasticsearch confirmed. Rows whose operation failed stay in
// the outbox and the job throws, so BullMQ retries with backoff. After the last
// attempt the job is kept as failed (visible in Bull Board and logs) and its
// rows remain, to be re-enqueued by the relay's next drain or fixed by reindex.

export const SEARCH_INDEX_QUEUE_NAME = 'search-index';
const JOB_NAME = 'apply-outbox';
export const MAX_OUTBOX_IDS_PER_JOB = 500;

export const searchIndexJobSchema = z.strictObject({
  outboxIds: z.array(z.string().regex(/^\d+$/)).min(1).max(MAX_OUTBOX_IDS_PER_JOB),
});
export type SearchIndexJobData = z.infer<typeof searchIndexJobSchema>;
export interface SearchIndexJobResult {
  applied: number;
  skipped: number;
}

export interface SearchQueueOptions extends QueueScope {
  attempts?: number;
  backoffMs?: number;
}

export function createSearchIndexQueue({ prefix, attempts = 10, backoffMs = 1_000 }: SearchQueueOptions = {}) {
  const defaultJobOptions: DefaultJobOptions = {
    // 10 attempts, 1s doubling: about 17 minutes of retries before giving up.
    attempts,
    backoff: { type: 'exponential', delay: backoffMs },
    removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  };
  return new Queue<SearchIndexJobData, SearchIndexJobResult>(SEARCH_INDEX_QUEUE_NAME, {
    connection: getRedisConnection(),
    prefix,
    defaultJobOptions,
  });
}

export type SearchIndexQueue = ReturnType<typeof createSearchIndexQueue>;

let searchQueue: SearchIndexQueue | undefined;
export function getSearchIndexQueue(): SearchIndexQueue {
  searchQueue ??= createSearchIndexQueue();
  return searchQueue;
}
export async function closeSearchIndexQueue() {
  const current = searchQueue;
  searchQueue = undefined;
  await current?.close();
}

// Deterministic id per batch of outbox rows: re-enqueueing the same rows is a no-op.
export const searchJobId = (ids: string[]) => `outbox-${ids[0]}-${ids[ids.length - 1]}-${ids.length}`;

export async function enqueueOutboxBatch(queue: SearchIndexQueue, ids: string[]) {
  const jobId = searchJobId(ids);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    // Still pending or running: nothing to do. Finished but rows still in the
    // outbox (e.g. a permanently failed job): replace it so it runs again.
    if (state !== 'completed' && state !== 'failed') return;
    await existing.remove();
  }
  await queue.add(JOB_NAME, { outboxIds: ids }, { jobId });
}

export interface SearchIndexConfig {
  client?: Client;
  index?: string;
}

const ensured = new Set<string>();

export async function applyOutboxRows(
  outboxIds: string[],
  { client = getElasticsearchClient(), index = env.ELASTICSEARCH_EMAIL_INDEX }: SearchIndexConfig = {},
): Promise<SearchIndexJobResult> {
  const rows = await prisma.searchOutbox.findMany({
    where: { id: { in: outboxIds.map((id) => BigInt(id)) } },
    select: { id: true, emailId: true, version: true },
  });
  if (rows.length === 0) return { applied: 0, skipped: outboxIds.length };

  if (!ensured.has(index)) {
    await ensureEmailIndex(client, index);
    ensured.add(index);
  }

  const byEmail = new Map<string, { ids: bigint[]; maxVersion: bigint }>();
  for (const row of rows) {
    const entry = byEmail.get(row.emailId) ?? { ids: [], maxVersion: 0n };
    entry.ids.push(row.id);
    if (row.version > entry.maxVersion) entry.maxVersion = row.version;
    byEmail.set(row.emailId, entry);
  }

  const emails = await prisma.email.findMany({
    where: { id: { in: [...byEmail.keys()] } },
    select: emailDocumentSelect,
  });
  const current = new Map(emails.map((e) => [e.id, e]));

  const ops: IndexOperation[] = [...byEmail.entries()].map(([emailId, entry]) => {
    const email = current.get(emailId);
    return email
      ? { kind: 'index', emailId, version: email.searchVersion, document: toEmailDocument(email) }
      : // The email no longer exists in PostgreSQL: remove it from the index.
        { kind: 'delete', emailId, version: entry.maxVersion };
  });

  const result = await bulkApply(client, index, ops);
  const doneIds = result.applied.flatMap((emailId) => byEmail.get(emailId)!.ids);
  if (doneIds.length) await prisma.searchOutbox.deleteMany({ where: { id: { in: doneIds } } });

  if (result.failed.length) {
    logger.warn('search indexing partially failed', {
      failed: result.failed.length,
      applied: result.applied.length,
      emails: result.failed.slice(0, 20),
    });
    throw new Error(`${result.failed.length} of ${ops.length} index operations failed`);
  }
  return { applied: result.applied.length, skipped: outboxIds.length - rows.length };
}

export interface SearchWorkerOptions extends QueueScope, SearchIndexConfig {
  concurrency?: number;
}

export function createSearchIndexWorker({ prefix, concurrency = 2, client, index }: SearchWorkerOptions = {}) {
  const worker = new Worker<SearchIndexJobData, SearchIndexJobResult>(
    SEARCH_INDEX_QUEUE_NAME,
    async (job) => {
      const parsed = searchIndexJobSchema.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError('Invalid search index job data');
      return applyOutboxRows(parsed.data.outboxIds, { client, index });
    },
    { connection: getRedisConnection(), prefix, concurrency },
  );
  worker.on('failed', (job, err) => {
    const final = !!job && job.attemptsMade >= (job.opts.attempts ?? 1);
    const log = final ? logger.error : logger.warn;
    log(final ? 'search index job failed permanently' : 'search index job failed, will retry', {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      outboxRows: job?.data.outboxIds.length,
      error: err.message,
    });
  });
  worker.on('error', (err) => logger.error('search index worker error', { err }));
  return worker;
}

export type SearchIndexWorker = ReturnType<typeof createSearchIndexWorker>;
