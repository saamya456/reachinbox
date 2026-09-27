import { Client, errors, type estypes } from '@elastic/elasticsearch';
import { env } from '../config/env.js';
import { htmlToText } from '../lib/html.js';
import { logger } from '../lib/logger.js';

// Elasticsearch client, email index definition and bulk writes.
//
// PostgreSQL is the source of truth; this index only serves search. Documents
// use the email id as _id and PostgreSQL's emails.search_version as an
// external version (version_type external_gte), so replays are idempotent and
// an older state can never overwrite a newer one.

export function createElasticsearchClient(options: { node?: string; requestTimeoutMs?: number } = {}) {
  const auth = env.ELASTICSEARCH_API_KEY
    ? { apiKey: env.ELASTICSEARCH_API_KEY }
    : env.ELASTICSEARCH_USERNAME && env.ELASTICSEARCH_PASSWORD
      ? { username: env.ELASTICSEARCH_USERNAME, password: env.ELASTICSEARCH_PASSWORD }
      : undefined;
  return new Client({
    node: options.node ?? env.ELASTICSEARCH_URL,
    ...(auth ? { auth } : {}),
    requestTimeout: options.requestTimeoutMs ?? 10_000,
    // Retries are handled by BullMQ (indexing) or surfaced as 503 (search).
    maxRetries: 0,
  });
}

let defaultClient: Client | undefined;
export function getElasticsearchClient(): Client {
  defaultClient ??= createElasticsearchClient();
  return defaultClient;
}
export async function closeElasticsearchClient() {
  const current = defaultClient;
  defaultClient = undefined;
  await current?.close();
}

export const physicalIndexName = (alias: string) => `${alias}-v1`;

export const EMAIL_INDEX_SETTINGS: estypes.IndicesIndexSettings = {
  number_of_shards: 1,
  // Single-node development cluster; raise with more nodes.
  number_of_replicas: 0,
  analysis: {
    tokenizer: {
      // "Jane.Doe@Acme.io" -> jane, doe, acme, io (so partial address search works).
      email_parts: { type: 'pattern', pattern: '[^A-Za-z0-9]+' },
    },
    analyzer: {
      email_parts: { type: 'custom', tokenizer: 'email_parts', filter: ['lowercase'] },
    },
    normalizer: {
      lowercase: { type: 'custom', filter: ['lowercase'] },
    },
  },
};

export const EMAIL_INDEX_PROPERTIES: Record<string, estypes.MappingProperty> = {
  emailId: { type: 'keyword' },
  userId: { type: 'keyword' },
  campaignId: { type: 'keyword' },
  senderId: { type: 'keyword' },
  recipientEmail: {
    type: 'text',
    analyzer: 'email_parts',
    fields: { keyword: { type: 'keyword', normalizer: 'lowercase' } },
  },
  subject: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 512 } } },
  body: { type: 'text' },
  status: { type: 'keyword' },
  scheduledAt: { type: 'date' },
  originalScheduledAt: { type: 'date' },
  sentAt: { type: 'date' },
  createdAt: { type: 'date' },
  updatedAt: { type: 'date' },
  rescheduleCount: { type: 'integer' },
  providerMessageId: { type: 'keyword' },
  previewUrl: { type: 'keyword', index: false },
  errorCode: { type: 'keyword' },
  // Plain-text preview of the body for list views (stored, not indexed).
  snippet: { type: 'keyword', index: false },
  searchVersion: { type: 'long' },
};

export const EMAIL_INDEX_MAPPINGS: estypes.MappingTypeMapping = {
  dynamic: 'strict',
  properties: EMAIL_INDEX_PROPERTIES,
};

type FieldMapping = { type?: string };

// Creates the index (and alias) if missing; otherwise validates that the
// existing mapping is compatible and adds any new fields. Never deletes data.
export async function ensureEmailIndex(client: Client, alias: string): Promise<'created' | 'exists'> {
  const aliasExists = await client.indices.existsAlias({ name: alias });
  if (!aliasExists) {
    if (await client.indices.exists({ index: alias })) {
      throw new Error(`"${alias}" exists as a concrete index, not an alias; refusing to use it`);
    }
    try {
      await client.indices.create({
        index: physicalIndexName(alias),
        settings: EMAIL_INDEX_SETTINGS,
        mappings: EMAIL_INDEX_MAPPINGS,
        aliases: { [alias]: { is_write_index: true } },
      });
      logger.info('elasticsearch email index created', { alias, index: physicalIndexName(alias) });
      return 'created';
    } catch (err) {
      // Another process created it concurrently.
      if (!(err instanceof errors.ResponseError && err.body?.error?.type === 'resource_already_exists_exception')) throw err;
    }
  }

  const mappings = await client.indices.getMapping({ index: alias });
  for (const [index, { mappings: current }] of Object.entries(mappings)) {
    const existing = (current.properties ?? {}) as Record<string, FieldMapping>;
    const missing: Record<string, unknown> = {};
    for (const [field, expected] of Object.entries(EMAIL_INDEX_PROPERTIES)) {
      const actual = existing[field];
      if (!actual) missing[field] = expected;
      else if (actual.type !== expected.type) {
        throw new Error(`Email index ${index}: field ${field} is ${actual.type}, expected ${expected.type}. Reindex into a new index version.`);
      }
    }
    if (Object.keys(missing).length) {
      await client.indices.putMapping({ index, properties: missing as Record<string, estypes.MappingProperty> });
      logger.info('elasticsearch email index mapping extended', { index, fields: Object.keys(missing) });
    }
  }
  return 'exists';
}

export interface EmailDocumentSource {
  id: string;
  userId: string;
  campaignId: string;
  senderId: string;
  recipientEmail: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt: Date;
  originalScheduledAt: Date;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  rescheduleCount: number;
  providerMessageId: string | null;
  previewUrl: string | null;
  errorCode: string | null;
  searchVersion: bigint;
}

export const emailDocumentSelect = {
  id: true,
  userId: true,
  campaignId: true,
  senderId: true,
  recipientEmail: true,
  subject: true,
  body: true,
  status: true,
  scheduledAt: true,
  originalScheduledAt: true,
  sentAt: true,
  createdAt: true,
  updatedAt: true,
  rescheduleCount: true,
  providerMessageId: true,
  previewUrl: true,
  errorCode: true,
  searchVersion: true,
} as const;

export function toEmailDocument(e: EmailDocumentSource) {
  return {
    emailId: e.id,
    userId: e.userId,
    campaignId: e.campaignId,
    senderId: e.senderId,
    recipientEmail: e.recipientEmail,
    subject: e.subject,
    body: e.body,
    status: e.status,
    scheduledAt: e.scheduledAt.toISOString(),
    originalScheduledAt: e.originalScheduledAt.toISOString(),
    sentAt: e.sentAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    rescheduleCount: e.rescheduleCount,
    providerMessageId: e.providerMessageId,
    previewUrl: e.previewUrl,
    errorCode: e.errorCode,
    snippet: htmlToText(e.body).replace(/\s+/g, ' ').slice(0, 200),
    searchVersion: Number(e.searchVersion),
  };
}

export type IndexOperation =
  | { kind: 'index'; emailId: string; version: bigint; document: ReturnType<typeof toEmailDocument> }
  | { kind: 'delete'; emailId: string; version: bigint };

export interface BulkResult {
  applied: string[];
  failed: { emailId: string; status: number; reason: string }[];
}

// One bulk request for many operations. Per item:
//  - 2xx, 409 (a newer version is already indexed) and 404 on delete count as applied;
//  - anything else is reported as failed with its email id.
export async function bulkApply(client: Client, alias: string, ops: IndexOperation[]): Promise<BulkResult> {
  if (ops.length === 0) return { applied: [], failed: [] };
  const operations: unknown[] = [];
  for (const op of ops) {
    const meta = { _index: alias, _id: op.emailId, version: Number(op.version), version_type: 'external_gte' as const };
    if (op.kind === 'index') operations.push({ index: meta }, op.document);
    else operations.push({ delete: meta });
  }
  const response = await client.bulk({ operations, require_alias: true });
  const result: BulkResult = { applied: [], failed: [] };
  response.items.forEach((item, i) => {
    const op = ops[i]!;
    const outcome = item.index ?? item.delete;
    const status = outcome?.status ?? 0;
    const ok = (status >= 200 && status < 300) || status === 409 || (op.kind === 'delete' && status === 404);
    if (ok) result.applied.push(op.emailId);
    else result.failed.push({ emailId: op.emailId, status, reason: outcome?.error?.type ?? 'unknown' });
  });
  return result;
}

export async function isElasticsearchUp(client: Client): Promise<boolean> {
  try {
    return await client.ping({}, { requestTimeout: 2_000 });
  } catch {
    return false;
  }
}
