import type { Client } from '@elastic/elasticsearch';
import type { Queue } from 'bullmq';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { googleConfigFromEnv, type GoogleOAuthConfig } from './auth/google.js';
import { requireTrustedOrigin } from './auth/middleware.js';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { getEmailQueue, type EmailQueue } from './queue/email.queue.js';
import { createQueueDashboardRouter, createQueueSummaryRouter, QUEUE_DASHBOARD_PATH } from './routes/admin.js';
import { createAuthRouter } from './routes/auth.js';
import { createCampaignsRouter, createEmailsRouter } from './routes/campaigns.js';
import { createHealthRouter } from './routes/health.js';
import { createSearchRouter } from './routes/search.js';
import { createSendersRouter } from './routes/senders.js';
import { createSlackRouter } from './routes/slack.js';
import { getElasticsearchClient } from './search/elasticsearch.js';
import { getSearchIndexQueue } from './search/search-index.queue.js';
import { slackConfigFromEnv, type SlackOAuthConfig } from './slack/slack-api.js';
import { getSlackQueue } from './slack/slack-notifications.js';

export interface AppOptions {
  // OAuth provider settings; default to env (null = not configured).
  google?: GoogleOAuthConfig | null;
  slack?: SlackOAuthConfig | null;
  // Elasticsearch client and email index alias; default to env.
  elasticsearch?: Client;
  searchIndex?: string;
  // Queues shown in the dashboard; default to the application's queues.
  dashboardQueues?: Queue[];
  adminEmails?: string[];
  // Queue that campaign creation schedules into; defaults to the app's queue.
  emailQueue?: EmailQueue;
}

export function createApp({
  google = googleConfigFromEnv(),
  slack = slackConfigFromEnv(),
  elasticsearch,
  searchIndex = env.ELASTICSEARCH_EMAIL_INDEX,
  dashboardQueues,
  adminEmails = env.ADMIN_EMAILS,
  emailQueue,
}: AppOptions = {}) {
  const app = express();
  const getSearchClient = () => elasticsearch ?? getElasticsearchClient();
  const queues = dashboardQueues ?? [getEmailQueue(), getSlackQueue(), getSearchIndexQueue()];

  // Mounted before the global helmet so it can set its own CSP (see routes/admin.ts).
  app.use(QUEUE_DASHBOARD_PATH, cookieParser(), createQueueDashboardRouter(queues, adminEmails));

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(cookieParser());
  // Compose submissions carry lead lists (up to 2 MB of CSV/text); every other
  // route keeps the small default limit.
  app.use('/api/campaigns', express.json({ limit: '3mb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(requireTrustedOrigin);

  app.use('/api/health', createHealthRouter(getSearchClient));
  app.use('/auth', createAuthRouter(google, adminEmails));
  app.use('/slack', createSlackRouter(slack));
  app.use('/api/senders', createSendersRouter());
  app.use('/api/campaigns', createCampaignsRouter(() => emailQueue ?? getEmailQueue()));
  app.use('/api/emails/search', createSearchRouter(getSearchClient, searchIndex));
  app.use('/api/emails', createEmailsRouter());
  app.use('/api/admin/queues', createQueueSummaryRouter(queues, adminEmails));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
