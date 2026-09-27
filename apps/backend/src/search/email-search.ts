import { errors, type Client, type estypes } from '@elastic/elasticsearch';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

// Tenant-scoped email search. Every query is built by buildEmailSearchQuery,
// which ALWAYS adds a `term: { userId }` filter taken from the session; there
// is no code path that searches the index without it.

export const EMAIL_STATUSES = ['SCHEDULED', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED', 'DELIVERY_UNKNOWN'] as const;
export const MAX_PAGE_SIZE = 100;
// Elasticsearch's default index.max_result_window.
export const MAX_RESULT_WINDOW = 10_000;

export const searchParamsSchema = z
  .strictObject({
    q: z.string().trim().max(200).optional(),
    // Comma-separated, e.g. status=SCHEDULED or status=SENT,FAILED
    status: z
      .string()
      .transform((v) => v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))
      .pipe(z.array(z.enum(EMAIL_STATUSES)).min(1).max(EMAIL_STATUSES.length))
      .optional(),
    senderId: z.uuid().optional(),
    campaignId: z.uuid().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
    sort: z.enum(['scheduledAt', 'sentAt', 'createdAt', 'relevance']).default('scheduledAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  .refine((p) => p.page * p.limit <= MAX_RESULT_WINDOW, {
    message: `page * limit must not exceed ${MAX_RESULT_WINDOW}`,
    path: ['page'],
  });

export type SearchParams = z.infer<typeof searchParamsSchema>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fields returned to clients (body is searchable but not returned).
const SOURCE_FIELDS = [
  'emailId',
  'campaignId',
  'senderId',
  'recipientEmail',
  'subject',
  'status',
  'scheduledAt',
  'sentAt',
  'createdAt',
  'rescheduleCount',
  'previewUrl',
  'errorCode',
  'snippet',
];

export function buildEmailSearchQuery(userId: string, params: SearchParams): estypes.SearchRequest {
  if (!userId) throw new Error('Email search requires a tenant');
  const filter: estypes.QueryDslQueryContainer[] = [{ term: { userId } }];
  if (params.status) filter.push({ terms: { status: params.status } });
  if (params.senderId) filter.push({ term: { senderId: params.senderId } });
  if (params.campaignId) filter.push({ term: { campaignId: params.campaignId } });

  const must: estypes.QueryDslQueryContainer[] = [];
  if (params.q) {
    const should: estypes.QueryDslQueryContainer[] = [
      {
        // Prefix-aware on the last word, so partial typing matches.
        multi_match: {
          query: params.q,
          type: 'bool_prefix',
          fields: ['subject^3', 'recipientEmail^2', 'body'],
          operator: 'and',
        },
      },
      { term: { 'recipientEmail.keyword': { value: params.q.toLowerCase(), boost: 10 } } },
    ];
    if (UUID.test(params.q)) should.push({ term: { emailId: params.q.toLowerCase() } });
    must.push({ bool: { should, minimum_should_match: 1 } });
  }

  const sort: estypes.Sort =
    params.sort === 'relevance'
      ? ['_score', { createdAt: { order: 'desc' } }, { emailId: { order: 'asc' } }]
      : [{ [params.sort]: { order: params.order, missing: '_last' } }, { emailId: { order: 'asc' } }];

  return {
    query: { bool: { filter, must } },
    sort,
    from: (params.page - 1) * params.limit,
    size: params.limit,
    track_total_hits: true,
    _source: SOURCE_FIELDS,
  };
}

interface EmailHitSource {
  emailId: string;
  campaignId: string;
  senderId: string;
  recipientEmail: string;
  subject: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  createdAt: string;
  rescheduleCount: number;
  previewUrl: string | null;
  errorCode: string | null;
  snippet?: string;
}

export class SearchUnavailableError extends Error {
  constructor(readonly reason: string) {
    super('Email search is temporarily unavailable');
    this.name = 'SearchUnavailableError';
  }
}

export async function searchEmails(client: Client, index: string, userId: string, params: SearchParams) {
  let response: estypes.SearchResponse<EmailHitSource>;
  try {
    response = await client.search<EmailHitSource>({ index, ...buildEmailSearchQuery(userId, params) });
  } catch (err) {
    // Connection/timeout errors, cluster errors and a missing index all mean
    // "search is unavailable". We never fall back to PostgreSQL.
    if (err instanceof errors.ConnectionError || err instanceof errors.TimeoutError) throw new SearchUnavailableError('unreachable');
    if (err instanceof errors.ResponseError) {
      const type = err.body?.error?.type;
      if (type === 'index_not_found_exception') throw new SearchUnavailableError('index_missing');
      if ((err.statusCode ?? 0) >= 500) throw new SearchUnavailableError('cluster_error');
    }
    throw err;
  }

  const hits = response.hits.hits.map((h) => h._source!).filter(Boolean);
  const total = typeof response.hits.total === 'number' ? response.hits.total : (response.hits.total?.value ?? 0);

  // Display names from PostgreSQL for this page only, scoped to the tenant.
  const senderIds = [...new Set(hits.map((h) => h.senderId))];
  const campaignIds = [...new Set(hits.map((h) => h.campaignId))];
  const [senders, campaigns] = await Promise.all([
    prisma.sender.findMany({ where: { userId, id: { in: senderIds } }, select: { id: true, email: true, displayName: true } }),
    prisma.campaign.findMany({ where: { userId, id: { in: campaignIds } }, select: { id: true, subject: true } }),
  ]);
  const senderById = new Map(senders.map((s) => [s.id, s]));
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));

  return {
    items: hits.map((h) => ({
      id: h.emailId,
      recipientEmail: h.recipientEmail,
      subject: h.subject,
      status: h.status,
      scheduledAt: h.scheduledAt,
      sentAt: h.sentAt,
      createdAt: h.createdAt,
      rescheduleCount: h.rescheduleCount,
      previewUrl: h.previewUrl,
      errorCode: h.errorCode,
      snippet: h.snippet ?? '',
      sender: senderById.get(h.senderId) ?? { id: h.senderId, email: null, displayName: null },
      campaign: campaignById.get(h.campaignId) ?? { id: h.campaignId, subject: null },
    })),
    page: params.page,
    limit: params.limit,
    total,
  };
}
