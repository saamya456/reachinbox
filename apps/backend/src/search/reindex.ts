import type { Client } from '@elastic/elasticsearch';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { bulkApply, emailDocumentSelect, ensureEmailIndex, toEmailDocument } from './elasticsearch.js';

// One-shot rebuild of the email index from PostgreSQL (read-only on the
// database). Pages through emails by id and indexes each page with one bulk
// request, using the email id as document id and search_version as external
// version: safe to rerun, never duplicates, never regresses a newer document.

export interface ReindexOptions {
  client: Client;
  index: string;
  batchSize?: number;
  // Limit to one tenant (tests / targeted repair).
  userId?: string;
  onProgress?: (progress: { indexed: number; failed: number }) => void;
}

export interface ReindexResult {
  indexed: number;
  failed: { emailId: string; status: number; reason: string }[];
}

export async function reindexEmails({ client, index, batchSize = 1_000, userId, onProgress }: ReindexOptions): Promise<ReindexResult> {
  await ensureEmailIndex(client, index);
  const result: ReindexResult = { indexed: 0, failed: [] };
  let lastId: string | undefined;
  for (;;) {
    const batch = await prisma.email.findMany({
      where: { ...(userId ? { userId } : {}), ...(lastId ? { id: { gt: lastId } } : {}) },
      select: emailDocumentSelect,
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (batch.length === 0) break;
    const bulk = await bulkApply(
      client,
      index,
      batch.map((e) => ({ kind: 'index' as const, emailId: e.id, version: e.searchVersion, document: toEmailDocument(e) })),
    );
    result.indexed += bulk.applied.length;
    result.failed.push(...bulk.failed);
    onProgress?.({ indexed: result.indexed, failed: result.failed.length });
    lastId = batch[batch.length - 1]!.id;
  }
  if (result.failed.length) logger.warn('reindex finished with failures', { failed: result.failed.length });
  return result;
}
