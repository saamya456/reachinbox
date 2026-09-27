import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { closeRedisConnection } from './queue/connection.js';
import { closeElasticsearchClient, ensureEmailIndex, getElasticsearchClient } from './search/elasticsearch.js';

// Make sure the search index exists (idempotent, never wipes data). If
// Elasticsearch is down the API still starts; search answers 503 until it is back.
ensureEmailIndex(getElasticsearchClient(), env.ELASTICSEARCH_EMAIL_INDEX).catch((err) =>
  logger.warn('elasticsearch index check failed at startup; search unavailable until it recovers', { err }),
);

const server = createApp().listen(env.PORT, () => {
  console.log(`Backend listening on http://localhost:${env.PORT}`);
});

const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down`);
  server.close();
  await prisma.$disconnect();
  await closeRedisConnection();
  await closeElasticsearchClient();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
