import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { Queue } from 'bullmq';
import { Router, type RequestHandler } from 'express';
import helmet from 'helmet';
import { requireAuth } from '../auth/middleware.js';
import { forbidden } from '../http/errors.js';
import { prisma } from '../lib/prisma.js';

// Operator-only queue monitoring.
//
// Queues are shared by all tenants, so the dashboard shows every tenant's jobs
// (ids only; payloads never contain credentials). Access therefore requires a
// signed-in user whose email is listed in ADMIN_EMAILS, not just any account.
// The dashboard is read-only: jobs cannot be retried, promoted or deleted
// from it. Repairs go through queue:reconcile / elasticsearch:reindex.

export const QUEUE_DASHBOARD_PATH = '/admin/queues';

export function requireAdmin(adminEmails: string[]): RequestHandler {
  const allowed = new Set(adminEmails.map((e) => e.toLowerCase()));
  return async (req, _res, next) => {
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { email: true } });
    if (!user || !allowed.has(user.email.toLowerCase())) throw forbidden('Administrator access required');
    next();
  };
}

// Bull Board's UI uses inline bootstrap scripts/styles, which the API's strict
// CSP blocks; this policy relaxes that for the dashboard pages only.
const dashboardCsp = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
});

export function createQueueDashboardRouter(queues: Queue[], adminEmails: string[]) {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(QUEUE_DASHBOARD_PATH);
  createBullBoard({
    queues: queues.map((q) => new BullMQAdapter(q, { readOnlyMode: true })),
    serverAdapter,
    options: { uiConfig: { boardTitle: 'ReachInbox queues' } },
  });
  const router = Router();
  router.use(requireAuth, requireAdmin(adminEmails), dashboardCsp, serverAdapter.getRouter());
  return router;
}

// JSON queue counts for a future admin view in the frontend.
export function createQueueSummaryRouter(queues: Queue[], adminEmails: string[]) {
  const router = Router();
  router.use(requireAuth, requireAdmin(adminEmails));
  router.get('/', async (_req, res) => {
    const summary = await Promise.all(
      queues.map(async (q) => ({
        name: q.name,
        counts: await q.getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed'),
      })),
    );
    res.json({ queues: summary });
  });
  return router;
}
