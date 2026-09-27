import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { enqueueOutboxBatch, getSearchIndexQueue, MAX_OUTBOX_IDS_PER_JOB, type SearchIndexQueue } from './search-index.queue.js';

// Moves search_outbox rows into the BullMQ search-index queue, event-driven:
//  - LISTEN email_search_outbox: the outbox trigger calls pg_notify on commit,
//    so every committed change wakes the relay immediately (push, no polling).
//    Notifications that arrive together (e.g. a bulk insert) are batched.
//  - drain(): one pass over the rows still in the outbox, run when the relay
//    (re)connects. It covers changes committed while no relay was listening
//    and jobs that ultimately failed. It is not repeated on a timer.
// If enqueueing fails the rows simply stay in the outbox for the next drain.

export const OUTBOX_CHANNEL = 'email_search_outbox';

export interface OutboxRelayOptions {
  queue?: SearchIndexQueue;
  connectionString?: string;
}

export interface OutboxRelay {
  drain(): Promise<number>;
  stop(): Promise<void>;
}

function pgConnectionString(url: string) {
  const parsed = new URL(url);
  parsed.searchParams.delete('schema'); // Prisma-specific parameter
  return parsed.toString();
}

export async function startOutboxRelay({
  queue = getSearchIndexQueue(),
  connectionString = env.DATABASE_URL,
}: OutboxRelayOptions = {}): Promise<OutboxRelay> {
  let client: pg.Client | undefined;
  let stopped = false;
  let reconnectDelay = 1_000;
  let pending: string[] = [];
  let flushScheduled = false;

  const enqueue = async (ids: string[]) => {
    for (let i = 0; i < ids.length; i += MAX_OUTBOX_IDS_PER_JOB) {
      await enqueueOutboxBatch(queue, ids.slice(i, i + MAX_OUTBOX_IDS_PER_JOB));
    }
  };

  const flush = () => {
    flushScheduled = false;
    const ids = pending;
    pending = [];
    enqueue(ids).catch((err) =>
      logger.error('search outbox enqueue failed; rows stay in the outbox until the next drain', { err, rows: ids.length }),
    );
  };

  async function drain(): Promise<number> {
    let last = 0n;
    let total = 0;
    for (;;) {
      const rows = await prisma.searchOutbox.findMany({
        where: { id: { gt: last } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: MAX_OUTBOX_IDS_PER_JOB,
      });
      if (rows.length === 0) break;
      await enqueue(rows.map((r) => r.id.toString()));
      total += rows.length;
      last = rows[rows.length - 1]!.id;
    }
    if (total) logger.info('search outbox drained', { rows: total });
    return total;
  }

  async function connect(): Promise<void> {
    const c = new pg.Client({ connectionString: pgConnectionString(connectionString) });
    c.on('notification', (msg) => {
      if (msg.channel !== OUTBOX_CHANNEL || !msg.payload) return;
      pending.push(msg.payload);
      // Notifications parsed from the same socket read arrive in one turn of
      // the event loop; flushing on the next turn batches them into one job.
      if (!flushScheduled) {
        flushScheduled = true;
        setImmediate(flush);
      }
    });
    c.on('error', (err) => logger.error('search outbox listener error', { err }));
    c.on('end', () => {
      if (stopped) return;
      logger.warn('search outbox listener disconnected; reconnecting', { inMs: reconnectDelay });
      scheduleReconnect();
    });
    await c.connect();
    // LISTEN before draining, so nothing committed in between is missed
    // (a row seen by both paths is enqueued once: job ids are deterministic).
    await c.query(`LISTEN ${OUTBOX_CHANNEL}`);
    client = c;
    reconnectDelay = 1_000;
    await drain();
  }

  // Reconnect backoff after a lost connection (not a polling loop: it only
  // runs while disconnected, and each success ends it).
  function scheduleReconnect() {
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    setTimeout(() => {
      if (stopped) return;
      connect().catch((err) => {
        logger.error('search outbox listener reconnect failed', { err });
        scheduleReconnect();
      });
    }, delay).unref();
  }

  await connect();
  logger.info('search outbox relay listening', { channel: OUTBOX_CHANNEL });

  return {
    drain,
    async stop() {
      stopped = true;
      await client?.end().catch(() => {});
    },
  };
}
