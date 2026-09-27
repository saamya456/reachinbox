// Manual maintenance: rebuild the Elasticsearch email index from PostgreSQL.
// Safe to rerun (deterministic ids + external versions); reads PostgreSQL only.
// Usage: npm run elasticsearch:reindex -w apps/backend
import { env } from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';
import { prisma } from '../src/lib/prisma.js';
import { closeElasticsearchClient, getElasticsearchClient } from '../src/search/elasticsearch.js';
import { reindexEmails } from '../src/search/reindex.js';

let exitCode = 0;
try {
  const started = Date.now();
  const result = await reindexEmails({
    client: getElasticsearchClient(),
    index: env.ELASTICSEARCH_EMAIL_INDEX,
    onProgress: (p) => logger.info('reindex progress', p),
  });
  logger.info('reindex finished', { index: env.ELASTICSEARCH_EMAIL_INDEX, indexed: result.indexed, failed: result.failed.length, ms: Date.now() - started });
  if (result.failed.length) {
    logger.error('reindex failures', { emails: result.failed.slice(0, 100) });
    exitCode = 1;
  }
} catch (err) {
  logger.error('reindex aborted', { err });
  exitCode = 1;
} finally {
  await closeElasticsearchClient();
  await prisma.$disconnect();
}
process.exit(exitCode);
