import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger.js';

// Errors meant for the client. Anything else becomes a generic 500 with no
// internal details (no stack traces, no database messages).
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    // Optional structured, client-safe details (e.g. which recipients are invalid).
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = () => new HttpError(401, 'unauthenticated', 'Authentication required');
export const forbidden = (message = 'Forbidden') => new HttpError(403, 'forbidden', message);
// Also used for resources owned by another tenant, so their existence is not revealed.
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
export const notConfigured = (what: string) =>
  new HttpError(503, 'not_configured', `${what} is not configured on this server`);

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
    });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({
      error: {
        code: 'invalid_input',
        message: 'Invalid input',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  // Unique constraint (Prisma P2002) that a route did not translate itself.
  if ((err as { code?: string }).code === 'P2002') {
    res.status(409).json({ error: { code: 'conflict', message: 'Resource already exists' } });
    return;
  }
  // express.json() parse errors.
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_json', message: 'Malformed JSON body' } });
    return;
  }
  logger.error('unhandled request error', { method: req.method, path: req.path, err });
  res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
};
