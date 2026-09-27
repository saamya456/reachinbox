import type { Client } from '@elastic/elasticsearch';
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { HttpError } from '../http/errors.js';
import { logger } from '../lib/logger.js';
import { searchEmails, searchParamsSchema, SearchUnavailableError } from '../search/email-search.js';

// GET /api/emails/search: Elasticsearch-backed, always scoped to req.auth.userId.
// If Elasticsearch is unavailable the request fails with 503; it never falls
// back to a database search.

export function createSearchRouter(getClient: () => Client, index: string) {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const params = searchParamsSchema.parse(req.query);
    try {
      res.json(await searchEmails(getClient(), index, req.auth!.userId, params));
    } catch (err) {
      if (err instanceof SearchUnavailableError) {
        logger.warn('email search unavailable', { reason: err.reason });
        throw new HttpError(503, 'search_unavailable', err.message);
      }
      throw err;
    }
  });

  return router;
}
