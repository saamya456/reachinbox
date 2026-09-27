// Imported first by test files so these values are set before env.ts parses
// process.env (dotenv never overrides variables that are already set).
process.env.NODE_ENV = 'test';
process.env.WORKER_CONCURRENCY = '3';
// Tests set spacing explicitly through campaign.delayBetweenEmailsMs.
process.env.MIN_SEND_DELAY_MS = '0';
// No global per-sender cap in tests; each test sets limits on its own senders.
process.env.MAX_EMAILS_PER_HOUR_PER_SENDER = '';
// The auth tests assert redirects and Origin checks against the default
// frontend origin, whatever a local .env uses (e.g. an HTTPS tunnel URL).
process.env.APP_URL = 'http://localhost:5173';
process.env.CORS_ORIGIN = 'http://localhost:5173';
