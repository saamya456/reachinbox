# ReachInbox: Full-stack Email Job Scheduler

A production-grade email scheduler and dashboard for the ReachInbox Software Development Intern assignment.

- **Scheduling:** you schedule a campaign (sender, lead list, subject, body, start time, delay between emails, hourly limit) from the web app. Every email becomes a **BullMQ delayed job** (no cron).
- **Sending:** emails go out through **Ethereal SMTP** from multiple senders. A Redis-backed **minimum delay** and **hourly limits** apply, and rate-limit hits are **rescheduled** into the next hour instead of dropped.
- **Restarts:** scheduling survives restarts without duplicates.
- **Search and monitoring:** scheduled and sent emails are searchable through **Elasticsearch**, the queues have a live **Bull Board** dashboard, and a **Slack** message is sent when a sender hits its hourly limit.

```
apps/
  backend/    TypeScript + Express + Prisma (PostgreSQL) + BullMQ (Redis) + Elasticsearch
  frontend/   React + TypeScript + Vite + Tailwind CSS (Figma-based UI)
e2e/          Playwright browser checks against the running stack
docker-compose.yml   PostgreSQL 16, Redis 7 (AOF), Elasticsearch 8.15
```

## Architecture

```
 Browser (React)  ──cookie session──►  API (Express, src/index.ts)
   Compose ──► POST /api/campaigns ──► PostgreSQL: campaign + emails (one transaction)
                                    └► BullMQ "email-scheduler": delayed job per email (id email-<emailId>)
   Scheduled/Sent ◄── GET /api/emails/search ◄── Elasticsearch (tenant-filtered)

 Worker process (src/worker.ts)
   email-scheduler worker ─► claim email (Postgres) ─► Redis rate limiter (hourly slot + min-delay gate)
        ├─ over the limit ─► reschedule: same job re-delayed to the next hour window
        └─ allowed ───────► Ethereal SMTP ─► SENT / FAILED / DELIVERY_UNKNOWN
            └─ hourly limit hit ─► "slack-notifications" queue ─► Slack incoming webhook
   Postgres triggers ─► search_outbox ─► LISTEN/NOTIFY relay ─► "search-index" queue ─► Elasticsearch bulk
   Startup: one reconciliation pass (every SCHEDULED email has its job; orphaned claims resolved)
```

## Assignment requirements → implementation

| Requirement | Where / how |
|---|---|
| **Backend** | |
| Accept scheduling requests via API | `POST /api/campaigns` (`src/routes/campaigns.ts`, `src/campaigns/campaign.service.ts`) |
| Store in a relational DB | PostgreSQL + Prisma (`prisma/schema.prisma`, 6 migrations) |
| BullMQ delayed jobs, no cron | `src/queue/*`, `scheduleNewEmails`/`scheduleEmail`. No cron, `node-cron`, Agenda or `setInterval` scheduling anywhere. |
| Multiple senders via Ethereal SMTP | Sender API + `POST /api/senders/ethereal`; nodemailer `SMTPConnection` (`src/services/smtp-delivery.service.ts`) |
| Searchable via Elasticsearch | Outbox triggers → relay → bulk indexing; `GET /api/emails/search` (`src/search/*`) |
| Live BullMQ dashboard | Bull Board at `/admin/queues` (admin-only, read-only) |
| Persistence across restarts, no duplicates | Jobs in Redis (AOF), deterministic job ids, atomic claims, startup reconciliation. Verified by a real restart in the E2E run. |
| Configurable worker concurrency | `WORKER_CONCURRENCY` (BullMQ `concurrency`) |
| Minimum delay between sends | `MIN_SEND_DELAY_MS` (default **2 s**) or the campaign's delay if larger, enforced per sender across all workers (Redis Lua gate) |
| Emails per hour, configurable, multi-worker safe | Per sender (`sender.hourly_limit`, capped by `MAX_EMAILS_PER_HOUR_PER_SENDER`) and per campaign (compose "Hourly Limit"); atomic Redis counters keyed by hour window + sender |
| Limit reached → reschedule, keep order | Same job re-delayed into the next window with increasing slots; `reschedule_count` recorded |
| Slack notification on rate-limit hit | Slack OAuth; webhook message once per sender/window; disconnect/reconnect without redeploy |
| Behaviour under load (1000+) | Tested: 1000 simultaneous emails and 1500-recipient campaigns |
| **Frontend** | |
| Real Google OAuth login | "Login with Google" → backend OpenID Connect flow (PKCE, nonce, state) → HttpOnly session |
| Header with name, email, avatar, logout | Sidebar user card (Figma) + top-bar user block |
| Dashboard: Scheduled / Sent tabs, Compose button | `/scheduled`, `/sent`, "Compose" |
| Compose: subject, body, CSV/text upload with count, start time, delay, hourly limit, Schedule | `/compose`: chips + server-parsed upload, rich-text body, delay, hourly limit, "Send Later" (date/time + time zone) |
| Scheduled table: email, subject, scheduled time, status | Server-side search, paging, filter, loading/empty/error states |
| Sent table: email, subject, sent time, status (sent/failed) | Same list; also shows `Unknown` honestly when SMTP delivery couldn't be confirmed |
| Code quality | Typed API layer (`src/api`, `src/types`), reusable UI components (`src/components/ui`), hooks, tests |

## Running locally

**Prerequisites:** Node.js ≥ 20 (developed on Node 24 / npm 11) and Docker Desktop.

```bash
cp .env.example .env
# ENCRYPTION_KEY (required): node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Google / Slack credentials: see the sections below (optional for local exploration)
npm install                              # all workspaces; runs `prisma generate`
npm run infra:up                         # PostgreSQL, Redis, Elasticsearch (docker compose up -d)
npm run prisma:deploy -w apps/backend    # apply migrations

# three terminals:
npm run dev:backend                      # API      http://localhost:4000
npm run dev:worker -w apps/backend       # worker   (BullMQ email + Slack + search-index workers, outbox relay)
npm run dev:frontend                     # web app  http://localhost:5173 (proxies /api, /auth, /slack, /admin to :4000)
```

Production-style: `npm run build`, then `node apps/backend/dist/index.js`, `node apps/backend/dist/worker.js`, and serve `apps/frontend/dist` behind the same origin as the API.

npm 11 blocks dependency install scripts unless they're allow-listed. The root `package.json` `allowScripts` allow-lists `prisma`, `@prisma/engines` and `esbuild`.

### Ethereal (fake SMTP)

No setup is needed. In the app, open **Settings → Senders → New Ethereal sender**, or use "Create Ethereal sender" in Compose. This creates a fresh Ethereal account and stores its password encrypted.

Sent emails never reach real inboxes; open an email and click **Ethereal preview → Open message**. From the CLI: `npm run sender:ethereal -w apps/backend -- <userId>`.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | local Postgres | PostgreSQL connection |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ, rate limiter, sessions |
| `ELASTICSEARCH_URL`, `ELASTICSEARCH_EMAIL_INDEX` | `http://localhost:9200`, `reachinbox-emails` | Search index (optional auth: `ELASTICSEARCH_API_KEY` or `_USERNAME`/`_PASSWORD`) |
| `ENCRYPTION_KEY` | (required) | AES-256-GCM key for SMTP passwords and Slack tokens |
| `WORKER_CONCURRENCY` | `5` | Parallel email jobs per worker process |
| `MIN_SEND_DELAY_MS` | `2000` | Minimum gap between two sends of one sender |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | `200` (empty = no global cap) | Global per-sender hourly cap on top of each sender's own limit |
| `APP_URL`, `CORS_ORIGIN` | `http://localhost:5173` | Frontend origin (redirects, allowed Origin) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | none | Google OAuth |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI` | none | Slack OAuth |
| `ADMIN_EMAILS` | none | Emails allowed to open Bull Board |

### Infrastructure

| Service | Port | Notes |
|---|---|---|
| PostgreSQL 16 | 5432 | volume `postgres_data` |
| Redis 7 | 6379 | volume `redis_data`; AOF (`everysec`) + RDB snapshots, `maxmemory-policy noeviction` (required by BullMQ) |
| Elasticsearch 8.15 | 9200 | single node, security disabled (dev only), 512 MB heap, 1.5 GB limit; volume `elasticsearch_data` |

`npm run infra:down` stops the containers (data is kept in volumes); `docker compose down -v` also deletes the data.

## Testing

```bash
npm test -w apps/backend     # 101 integration tests on real PostgreSQL, Redis, Elasticsearch (+ Ethereal)
npm test -w apps/frontend    # 29 component/unit tests (Vitest + Testing Library)
npm run typecheck && npm run build
npm run db:verify -w apps/backend   # database constraint checks
```

**Browser end-to-end check** (`e2e/`, Playwright, against the running stack):

```bash
npm run install-browser -w e2e       # once: downloads Chromium
# E2E_SESSION: the ri_sid cookie of a signed-in browser, or (development only, needs DB access):
npm run dev:session -w apps/backend -- you@example.com   # prints {"sessionId": ...}
cd e2e
E2E_SESSION=<sessionId> npx playwright test --grep @before-restart
#   now stop and start the API and the worker
E2E_SESSION=<sessionId> npx playwright test --grep @after-restart
```

It covers:
- the login redirect and creating an Ethereal sender;
- compose with chips and a CSV upload, a delay of 3 s and an hourly limit of 5 for 7 recipients: exactly 5 are delivered to Ethereal (preview pages checked), at least 3 s apart, and 2 are rescheduled to the next hour;
- Elasticsearch search, the email detail view and Bull Board;
- a campaign scheduled 3 minutes ahead in the user's time zone, which after a restart is sent once at the right time;
- logout.

`dev:session` exists because real Google sign-in needs OAuth credentials and a human at the consent screen. It is refused in production and is not a login path of the app.

## Frontend

React 19 + React Router + Tailwind CSS, following the Figma frames:
- login card with "Login with Google";
- sidebar with the user card, the green "Compose" pill and "CORE" navigation with live counts;
- search bar with filter and refresh;
- list rows reading "To: …" with a status pill (scheduled time, Sent, Failed, Unknown), subject and snippet;
- Gmail-like email detail;
- compose screen with recipient chips (+N), "Upload List", "Delay between 2 emails", "Hourly Limit", a rich-text editor toolbar, and the "Send Later" popover.

- **Data:** everything comes from the API; lists use server-side search and paging (`/api/emails/search`).
- **Structure:** `src/api` (typed client + endpoints), `src/types`, `src/auth` (session state, protected routes), `src/components/{ui,layout,emails,compose}`, `src/pages`, `src/hooks`, `src/utils`.
- **Session:** only the HttpOnly session cookie; no tokens in `localStorage`/`sessionStorage`. A 401 anywhere sends the user to `/login`.
- **Time zones:** the user picks a wall-clock time and an IANA zone (default: the browser's). It is converted with `@date-fns/tz`; DST gaps are rejected. The backend receives an absolute ISO instant; "Now" uses the exact current instant.
- **HTML safety:** the editor's HTML is sanitized on the **server** before it is stored and again before it is sent or displayed; the detail view also passes it through DOMPurify.
- **Presented differences from the Figma:**
  - no email/password form (the required authentication is Google OAuth);
  - no star/archive/delete icons (they would be non-functional);
  - added a user block in the top bar, a timezone picker, "Unknown" delivery status, and Settings (senders, Slack).

## Compose / campaign API

| Method & path | Description |
|---|---|
| `POST /api/campaigns` | `{ senderId, subject, body, recipients: string[], recipientsText?, startAt (ISO with offset), timezone?, delayBetweenEmailsSeconds (0–3600), hourlyLimit? (1–10000), clientRequestId? }` |
| `POST /api/campaigns/recipients/parse` | `{ text }` → `{ emails, total, valid, invalid, duplicatesRemoved, invalidEntries }` (upload preview) |
| `GET /api/campaigns`, `GET /api/campaigns/:id` | Campaigns with sender, recipient count, per-status counts and derived status |
| `POST /api/campaigns/:id/cancel` | Cancels every email not yet claimed by a worker |

**Recipients:**
- **Parsing:** chips and CSV/text are parsed server-side (headers, quoted cells, `,` `;` tab and whitespace separators), lower-cased, validated and de-duplicated keeping the first occurrence.
- **Invalid addresses:** any invalid address rejects the request (400 with the invalid rows); nothing is silently dropped.
- **Limits:** 2 MB of input, 50 000 rows, 10 000 recipients.

**Persistence:**
- **One transaction:** the campaign and all its emails are written in one transaction (chunked `createMany`).
- **Planned times:** email *i* is planned at `startAt + i × delay`.
- **Idempotency key:** each email's is `sha256(campaignId:recipient)`.
- **Double submits:** `clientRequestId` makes a double-submitted compose return the same campaign.
- **Queueing:** jobs are added in bulk with the deterministic `email-<id>` ids. If adding them fails after the commit, the response reports `pendingReconciliation` and the worker's startup reconciliation (or `npm run queue:reconcile`) queues them. No email is lost.

**Status:**
- **Derived** from real email states: `DRAFT` (no emails), `SCHEDULED`, `RUNNING`, `COMPLETED`.
- **`CANCELLED`** is the only explicit status.
- **Cancellation vs. workers:** cancellation and the worker's claim both require `status = SCHEDULED`, and the claim also refuses emails of a cancelled campaign, so an email is either cancelled or sent, never both. Emails already being sent or sent are left alone.

## Known assumptions and trade-offs

- **Real providers not verified:** Google and Slack OAuth were exercised against protocol-faithful local stand-ins in the tests, not against the real providers (no credentials were available). The Slack "live message" therefore needs your Slack app credentials to demonstrate.
- **At-most-once delivery:** if an SMTP interaction may have been accepted but its result was lost, the email becomes `DELIVERY_UNKNOWN` and is never retried (shown as "Unknown", not "Sent").
- **Rate limits:** clock-hour windows can allow up to 2× the limit across a window boundary. The minimum delay applies per sender.
- **Ordering:** exact with concurrency 1; with concurrency > 1, emails due at the same moment can be reordered by up to concurrency × workers.
- **Search:** eventually consistent (about a second); after scheduling, the Scheduled view refreshes itself briefly.
- **Private SMTP hosts** (e.g. a local MailHog) are blocked by the SSRF protection.

## Authentication (Google OAuth)

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client of type "Web application" (Google Cloud Console → APIs & Services → Credentials). If unset, `/auth/google` returns 503. |
| `GOOGLE_CALLBACK_URL` | Default `http://localhost:4000/auth/google/callback`. Must be registered as an *Authorized redirect URI* in the client. |
| `APP_URL` | Frontend origin; where the browser lands after sign-in (default `http://localhost:5173`). |

The flow is **authorization code + OpenID Connect** (`src/auth/google.ts`, `src/routes/auth.ts`):

1. **`GET /auth/google`:** creates a one-time `state`, a PKCE verifier and a `nonce`, and stores them server-side in Redis for 10 minutes. It sets an HttpOnly *binding* cookie whose hash is stored with the state, then redirects to Google (`scope=openid email profile`, `code_challenge_method=S256`).
2. **`GET /auth/google/callback`:**
   - consumes the state (single use, `GETDEL`) and requires the binding cookie of the browser that started the flow; this prevents login CSRF;
   - exchanges the code (with the client secret and PKCE verifier, server-side only);
   - verifies the ID token: RS256 signature against Google's JWKS, `iss`, `aud` = our client id, `exp`, and `nonce`;
   - requires `email_verified`;
   - creates or updates the local user by Google `sub`, storing name, email and avatar;
   - starts a new session and redirects to `APP_URL` + an optional `returnTo` path.
3. **Errors:** any failure redirects to `APP_URL/login?error=<code>` and creates no session. `returnTo` must be a plain path (`/…`); absolute, protocol-relative or backslash URLs are ignored, so there is no open redirect.

Google access and refresh tokens are **not stored**; only the verified identity is used. The client secret and authorization codes are never logged or sent to the browser.

### Sessions

- **Cookie:** the browser receives one opaque cookie, `ri_sid` (`__Host-ri_sid` in production). It holds a random 256-bit id, is `HttpOnly` and `SameSite=Lax`, is `Secure` when `NODE_ENV=production`, uses `Path=/`, and lasts 7 days.
- **Storage:** sessions live in Redis under the **SHA-256** of that id, so a Redis dump contains no usable cookies. Nothing is stored in `localStorage`/`sessionStorage` or put in URLs.
- **`GET /auth/me`** → `{ id, name, email, avatarUrl, isAdmin }` (401 without a valid session).
- **`POST /auth/logout`** deletes the Redis session (server-side invalidation: a copied cookie stops working immediately) and clears the cookie.
- **Session rotation:** every login creates a new session id and drops the previous one, which prevents session fixation.
- **CSRF:** `SameSite=Lax` keeps the cookie off cross-site POSTs. In addition, state-changing requests that carry an `Origin` header are rejected (403) unless it is `APP_URL`/`CORS_ORIGIN`.

## API and tenant isolation

Authentication (who you are) comes only from the session: `requireAuth` resolves the cookie to exactly one user and sets `req.auth.userId`. Authorization (what you may touch) is ownership: every query is filtered by `req.auth.userId`.

- **No client identity:** a `userId` in a body, query or path is never used. Request bodies are strict, so unknown fields such as `userId` are rejected with 400.
- **Other tenants' resources** return **404** (not 403), so their existence isn't revealed.
- **Database backstop:** PostgreSQL enforces it too: emails reference campaigns and senders through composite `(id, user_id)` foreign keys (Phase 2).

| Method & path | Description |
|---|---|
| `GET /auth/google`, `GET /auth/google/callback` | Google sign-in |
| `GET /auth/me`, `POST /auth/logout` | Current user / logout |
| `GET /api/senders` | List own senders |
| `POST /api/senders` | Create: `{ email, displayName?, smtpHost, smtpPort, smtpSecure?, smtpUser, smtpPassword, hourlyLimit }` |
| `POST /api/senders/ethereal` | Create a sender backed by a new Ethereal test account: `{ displayName?, hourlyLimit? }` |
| `GET /api/senders/:id` | Get own sender |
| `PATCH /api/senders/:id` | Update any field above, plus `isActive` (activate/deactivate); `smtpPassword` rotates the stored secret |
| `DELETE /api/senders/:id` | Deletes a sender without email history; otherwise deactivates it (`{ outcome }`) |
| `POST /api/campaigns`, `GET /api/campaigns`, `GET /api/campaigns/:id`, `POST /api/campaigns/:id/cancel` | Campaigns (see Compose / campaign API) |
| `GET /api/emails/search`, `GET /api/emails/:id` | Search own emails (Elasticsearch) / email detail with sanitized body |
| `GET /slack/connect`, `GET /slack/callback` | Slack OAuth |
| `GET /slack/status`, `POST /slack/disconnect` | Slack connection status / disconnect |

- **Errors:** errors use `{ error: { code, message } }`: 400 invalid input or unsafe SMTP host, 401 unauthenticated, 403 cross-origin, 404 not found / not yours, 409 duplicate sender email, 503 provider not configured. Stack traces and database details are never returned.
- **Sender responses** never contain the SMTP password, the encrypted blob, or the owner id.
- **Deactivating a sender** makes its still-scheduled emails fail with `SENDER_INACTIVE` when they come due (Phase 4 behavior).

### SMTP host validation (SSRF)

User-supplied SMTP settings make the worker open outbound connections, so `src/security/smtp-host.ts` restricts them. The checks run **when a sender is created or updated**:

- only ports **25, 465, 587, 2525**;
- the host must be a fully qualified hostname or an IP literal. Single-label names such as `redis` or `postgres` resolve to internal services (e.g. in Docker);
- `localhost`, `*.local`, `*.internal` (e.g. `metadata.google.internal`), `*.home.arpa` and similar names are rejected;
- the name is resolved and **every** address must be public. Rejected ranges:
  - loopback, `0/8`, RFC 1918 private ranges, CGNAT `100.64/10`;
  - link-local `169.254/16` (cloud metadata `169.254.169.254`);
  - documentation, benchmarking, multicast and reserved ranges;
  - IPv6 `::1`, ULA `fc00::/7` (incl. `fd00:ec2::254`), link-local `fe80::/10`, NAT64, 6to4, Teredo and multicast;
  - IPv4-mapped IPv6 addresses, which are checked as IPv4.

**At send time** the host is resolved and checked again, and the SMTP connection is made **to that checked IP**. TLS still verifies the certificate against the hostname. This defeats DNS rebinding after the sender was saved.

Trade-off: SMTP servers on private networks (e.g. a local MailHog) cannot be used. Ethereal (`smtp.ethereal.email:587`) and public providers work unchanged.

## Slack integration

| Variable | Purpose |
|---|---|
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | From your Slack app (api.slack.com/apps → Basic Information). If unset, `/slack/connect` returns 503. |
| `SLACK_REDIRECT_URI` | Default `http://localhost:4000/slack/callback`. Add it under *OAuth & Permissions → Redirect URLs*. Slack requires HTTPS redirect URLs, so in development expose the backend through an HTTPS tunnel and set this variable to the tunnel URL. |

The Slack app needs one scope: **`incoming-webhook`**.

- **Connect:** `GET /slack/connect` (signed in) → Slack consent, where the user picks a channel → `GET /slack/callback`.
  - **Binding:** the one-time state is bound to the **user and the session** that started the flow, so a callback URL completed in another session (or by another user) is rejected. A user id from the request is never used.
  - **Exchange:** the code is exchanged via `oauth.v2.access`. The webhook URL must be on `hooks.slack.com` (https).
  - **Storage:** the bot token and the incoming-webhook URL are stored **encrypted** (AES-256-GCM, `ENCRYPTION_KEY`).
  - **One connection per user:** connecting again replaces the old one and revokes its token.
- **Status:** `GET /slack/status` → `{ status: connected | disconnected | revoked | error, configured, teamName, channelName, connectedAt, lastNotifiedAt, lastError }`. It never returns tokens or the webhook URL.
- **Disconnect:** `POST /slack/disconnect` deletes the stored credentials (no notification can use them afterwards) and calls `auth.revoke` at Slack (best effort; `revoked` in the response reports whether Slack confirmed). Reconnecting is always possible.

### Hourly-limit notifications

1. **Event:** the Phase 4 `hourlyLimitReached` event fires once per sender (or campaign) and window, across all worker processes.
2. **Queue:** in the worker process it is turned into a job on a separate BullMQ queue, `slack-notifications`. The job id is deterministic (`hourly-limit-<user>-<scope>-<id>-<window>`), so duplicates are no-ops. Job data holds ids only.
3. **Message:** a Slack notification worker posts one message to the user's connected channel. It covers what reached the limit (sender or campaign) and the limit value, the window, the next sending slot, and how many emails have been moved to a later window.

**Failures never affect email sending:**
- event subscribers run in isolation and enqueue errors are only logged;
- Slack runs in its own worker;
- network errors, 5xx and 429 are retried with backoff (5 attempts);
- Slack answers meaning the credential is dead (`no_service`, `invalid_token`, `channel_not_found`, 403/404/410, …) mark the connection `REVOKED` (other 4xx: `ERROR`). It is then never used again until the user reconnects;
- without an active connection, the notification is skipped.

## Email search (Elasticsearch)

**PostgreSQL is the source of truth. Elasticsearch is only a search index**: it is never read to make decisions about email state, and search never falls back to PostgreSQL.

| Variable | Purpose |
|---|---|
| `ELASTICSEARCH_URL` | Default `http://localhost:9200` |
| `ELASTICSEARCH_EMAIL_INDEX` | Alias used for reads and writes (default `reachinbox-emails`). The physical index is `<alias>-v1`, the alias's write index. |
| `ELASTICSEARCH_API_KEY` or `ELASTICSEARCH_USERNAME`/`ELASTICSEARCH_PASSWORD` | Optional credentials (the local container has security disabled). Never logged. |

### Architecture

```
UPDATE/INSERT/DELETE emails        (any code path: Prisma, createMany, cascades)
   └─ trigger, same transaction ──► search_outbox row  (+ emails.search_version++)
                                    └─ pg_notify on commit
relay (worker process, LISTEN) ──► BullMQ "search-index" job { outboxIds } (batched, deterministic job id)
search-index worker ──────────────► reads CURRENT rows from PostgreSQL
                                  ──► one Elasticsearch _bulk request
                                  ──► deletes only the outbox rows Elasticsearch confirmed
```

- **Triggers** (migration `search_outbox`): a change to a searchable or state column (recipient, subject, body, status, scheduled/sent time, provider id, preview URL, reschedule count, error code) increments `emails.search_version` and inserts an outbox row. Inserts and deletes do too. Bookkeeping-only updates (claim token, attempts) do not. Because the outbox row commits **atomically** with the change, an index update cannot be lost between PostgreSQL and the queue, and no application write path had to change.
- **Relay:** `LISTEN email_search_outbox` is push-based. Notifications arriving together (a 1000-row insert) are batched into jobs of up to 500 rows. On (re)connect it drains the outbox **once**, which picks up changes committed while no relay was listening and rows of jobs that finally failed. There is no polling, cron or `setInterval`.
- **Idempotency and ordering:**
  - document `_id` = email id;
  - every write uses `version = search_version` with `version_type=external_gte`: replays are no-ops, and an older state can never overwrite a newer one (the conflict is treated as "already applied");
  - deletes carry `search_version + 1`;
  - writes use `require_alias`, so a missing alias can never auto-create a dynamically mapped index.

### Consistency and retries

- **Eventual consistency:** a change is searchable once its job runs (typically well under a second, plus Elasticsearch's 1 s refresh). There is no synchronous consistency.
- **Elasticsearch fails after the PostgreSQL commit:** the job retries with exponential backoff (10 attempts, 1 s doubling, about 17 min). The outbox rows stay until Elasticsearch confirms them.
- **Retries give up:** the job is kept as *failed* (visible in Bull Board, error logged with email ids). Its rows remain and are re-enqueued on the next relay start, or `npm run elasticsearch:reindex` repairs everything.
- **Elasticsearch applied the update, but the worker crashed before acknowledging:** the retry re-applies the same version, which is a harmless no-op.
- **Partial bulk failures** are handled per item: successful emails are acknowledged; failed ones are logged by id and retried.

### Elasticsearch outage

- **Unaffected:** email scheduling, sending and Slack. The email path only writes PostgreSQL; the triggers add an outbox row.
- **Affected:**
  - `GET /api/emails/search` returns **503** `search_unavailable`;
  - `/api/health` reports `elasticsearch: "down"`, `status: "degraded"` (still 200);
  - index jobs retry.
- **Recovery:** when Elasticsearch returns, queued jobs catch up without duplicates. Verified by a test that pauses the Elasticsearch container while an email is sent.

### Mapping (`dynamic: strict`)

| Field | Type |
|---|---|
| `emailId`, `userId`, `campaignId`, `senderId`, `status`, `providerMessageId`, `errorCode` | `keyword` (exact filters) |
| `recipientEmail` | `text` with an `email_parts` analyzer (`jane.doe@acme.io` → `jane`, `doe`, `acme`, `io`) + `recipientEmail.keyword` (lower-cased exact) |
| `subject` | `text` + `subject.keyword` |
| `body` | `text` (searchable, not returned by the API) |
| `scheduledAt`, `originalScheduledAt`, `sentAt`, `createdAt`, `updatedAt` | `date` |
| `rescheduleCount` | `integer` |
| `searchVersion` | `long` |
| `previewUrl` | `keyword`, not indexed |

The API and the worker create the index on startup if it is missing. If it exists, they validate the field types and add new fields; they never delete or recreate it.

### Search API

`GET /api/emails/search` (signed in) with these parameters:

| Parameter | Values |
|---|---|
| `q` | Free text over subject (×3), recipient (×2) and body. The last word is matched as a prefix. An exact address or email id also matches. |
| `status` | One or more of `SCHEDULED,PROCESSING,SENT,FAILED,CANCELLED,DELIVERY_UNKNOWN` (comma-separated) |
| `senderId`, `campaignId` | UUID exact filters |
| `sort` | `scheduledAt` (default), `sentAt`, `createdAt`, `relevance` |
| `order` | `asc` or `desc` (default) |
| `page` | Default 1 |
| `limit` | 1–**100**, default 20 |

- **Validation:** `page × limit` ≤ 10 000 (Elasticsearch's result window). Unknown parameters (e.g. `userId`) → 400.
- **Response:** `{ items, page, limit, total }`, one item per email. Each item holds `id, recipientEmail, subject, status, scheduledAt, sentAt, createdAt, rescheduleCount, previewUrl, errorCode`, plus `sender: { id, email, displayName }` and `campaign: { id, subject }`, which are loaded from PostgreSQL for the returned page only.
- **Sorting:** emails without `sentAt` sort last.
- **Tenant isolation:** every query is built by one function that always adds `filter: term userId = <session user>`. The user id is never taken from the request.

### Reindex

```bash
npm run elasticsearch:reindex -w apps/backend
```

- **One-shot, manual:** rebuilds the index from PostgreSQL in pages of 1 000, one bulk request per page. It reports progress and failed ids, and exits non-zero on failures.
- **Safe to rerun:** deterministic ids plus external versions. It only reads PostgreSQL.
- **Limitation:** it does not remove documents of emails that no longer exist. Deletions normally reach the index through the delete trigger.

## Queue dashboard (Bull Board)

- **Route:** `/admin/queues` (UI) and `/admin/queues/api/*` (its data). A JSON summary is also available at `GET /api/admin/queues`.
- **Access:**
  - **signed-in session** (Phase 5 cookie), otherwise 401;
  - the user's email must be in **`ADMIN_EMAILS`**, otherwise 403. Queues are shared by all tenants, so any-account access would expose other tenants' operational data;
  - the dashboard's assets are behind the same checks.
- **Queues shown:** `email-scheduler`, `slack-notifications`, `search-index`, with live waiting / delayed / active / completed / failed counts and job details.
- **Read-only:** jobs cannot be retried, promoted, cleaned or deleted from the UI. Repairs go through `queue:reconcile` and `elasticsearch:reindex`.
- **Payloads:** every job holds ids only (verified by a test inspecting the raw Redis hashes of all three queues), so the dashboard cannot reveal credentials.
- **CSP:** Bull Board needs inline scripts. A relaxed CSP applies **only** under `/admin/queues`; API routes keep helmet's strict policy.

## Security summary

- **Secrets at rest:** SMTP passwords, Slack tokens and Slack webhook URLs are encrypted (AES-256-GCM). Google tokens are not stored.
- **Secrets in transit to the client:** API responses use explicit safe selects; no endpoint returns passwords, tokens, webhook URLs or encrypted blobs.
- **Queues:** job payloads (`email-scheduler`, `slack-notifications`, `search-index`) contain ids only; the queue dashboard is admin-only and read-only.
- **Search:** every Elasticsearch query is filtered by the session's user id; results carry display fields only.
- **Logs:** the structured logger never receives tokens, passwords, OAuth codes/states or webhook URLs, and redacts secret-looking keys as a safeguard. A full test run's logs were scanned for these values: none found.
- **Browser:** only the HttpOnly session cookie. No tokens in JavaScript-readable storage.

## Email scheduling (BullMQ)

Scheduling uses **BullMQ delayed jobs only**. There is no cron, `setInterval` or database polling.

| | |
|---|---|
| Queue | `email-scheduler` (job name `send-email`) |
| Redis | one shared ioredis client per process (`src/queue/connection.ts`, from `REDIS_URL`), used by Queue, Worker and QueueEvents |
| Job data | `{ emailId, userId, campaignId, senderId }`. Identifiers only, no secrets. The PostgreSQL `emails` row is the source of truth. |
| Job id | `email-<emailId>`, deterministic. BullMQ ignores adding an id that already exists, so scheduling twice, retries and restarts never create a second job for one email. |
| Delay | `max(0, scheduledAt - now)`. A past `scheduledAt` means the job runs immediately. |
| Concurrency | `WORKER_CONCURRENCY` (default 5): jobs processed in parallel per worker process |
| Minimum delay | `max(MIN_SEND_DELAY_MS, campaign.delay_between_emails_ms)` between two sends **of the same sender**, across all workers and processes (`MIN_SEND_DELAY_MS` default 2000) |
| Hourly limits | `sender.hourly_limit` and `campaign.hourly_limit`, both enforced per clock hour |
| Retries | 3 attempts, exponential backoff from 5s, only for infrastructure errors before delivery starts. Once SMTP interaction may have begun, nothing is retried automatically. |
| Persistence | Delayed jobs live in Redis, which uses AOF + RDB (see Infrastructure), so they survive worker and Redis restarts. |

## Email delivery

```
BullMQ delayed job (email-<emailId>)
        ↓
worker: re-read the email row, check ownership, skip SENT/FAILED/CANCELLED/DELIVERY_UNKNOWN
        ↓
claim email            SCHEDULED → PROCESSING (fresh processing_token)
        ↓
rate-limit reservation  sender + campaign hourly counters, planned slot   (Redis Lua, atomic)
        ↓               slot in a later window / far away → SCHEDULED again at the slot, same job re-delayed
minimum-delay gate      now ≥ slot and now ≥ sender gate → gate = now + delay (Redis Lua, atomic)
        ↓
delivery_started_at = gate time, attempts + 1
        ↓
SMTP delivery (Ethereal)
        ↓
SENT / FAILED / DELIVERY_UNKNOWN   (each write conditional on processing_token)
```

Code: `src/services/email-processing.service.ts` (state machine), `src/services/rate-limit/send-rate-limiter.ts` (Redis algorithms), `src/services/smtp-delivery.service.ts` (SMTP), `src/events/email-events.ts` (`hourlyLimitReached` event for the Slack phase).

### Ethereal / SMTP setup

Each sender row stores `smtp_host`, `smtp_port`, `smtp_secure` (implicit TLS; otherwise STARTTLS when offered), `smtp_user` and the password **encrypted** (AES-256-GCM, `ENCRYPTION_KEY`). The password is decrypted only inside the SMTP delivery service, just before AUTH. It is never put in job data, logs, errors or API selects.

To create an Ethereal test account and store it as a sender for an existing user:

```bash
npm run sender:ethereal -w apps/backend -- <userId> [hourlyLimit]
```

Ethereal accepts mail but never delivers it; each sent email stores `preview_url` (`https://ethereal.email/message/...`), plus `provider_message_id` (the id from the server's final reply, e.g. Ethereal `MSGID` or `queued as X`) and `sent_at`.
Every message carries a deterministic `Message-ID: <idempotency_key@sender-domain>`, so an email can be looked up at the provider and receivers can de-duplicate it.

### Hourly limit algorithm

- **Fixed windows:** windows are aligned to the clock (`window = floor(t / 1h)`) and all times come from the **Redis server clock** (`TIME`), so hosts can't disagree.
- **Keys:** per sender and window, a hash `rl:{s:<senderId>}:w:<window>` holds `{ count, cursor }`; per campaign and window, a hash `rl:c:<campaignId>:w:<window>` holds `{ count }`.
- **Reserve script:** checks both counts against `sender.hourly_limit` / `campaign.hourly_limit` and, if the window has room, takes `slot = max(now, windowStart, cursor)`, increments both counts and sets `cursor = slot + delay`. All of this happens in one Lua script, so concurrent workers cannot exceed a limit. The "A sees 99, B sees 99, result 101" race is impossible.
- **Full window:** the next window is tried. The email is not failed: it goes back to `SCHEDULED` with `scheduled_at` = its reserved slot, `reschedule_count + 1` and `last_rescheduled_at`, and the **same** BullMQ job is re-delayed to that time (`moveToDelayed`, same `email-<emailId>` id, so no duplicate job).
- **Next window:** its slots are also reserved and spaced by the delay, so a limit of 100 sends emails 1–100 now, emails 101–200 in the next hour, and so on.
- **Notification:** the first email pushed out of a window emits `hourlyLimitReached` once per sender (or campaign) and window, across all processes (`HSETNX`). Phase 5 will subscribe to it; nothing is sent to Slack yet.

Note: fixed windows allow up to 2× the limit within a rolling 60 minutes that straddles a boundary (N at 10:59, N at 11:00). This is the usual fixed-window trade-off: it keeps reschedule targets predictable (the next clock hour).

### Minimum-delay algorithm

Minimum delay is enforced **per sender**, measured between send authorizations:

1. **Planned slots:** the reservation cursor above hands out slots spaced by `delay`. 1000 simultaneous emails therefore get 1000 distinct slots and are re-delayed to them, instead of all waking at once and competing.
2. **Send gate:** right before SMTP, a second Lua script requires `now ≥ slot` and `now ≥ gate`. It then sets `gate = now + delay` and consumes the reservation, atomically. This is what guarantees that no two sends from one sender are authorized less than `delay` apart, whichever worker or process they run in, even if a job wakes late.

- **Short waits** (≤ 5 s in total per attempt) happen in-process; longer ones release the claim and re-delay the job.
- **Measurement:** `delivery_started_at` records the gate time. The SMTP call starts right after one conditional database write.
- **No timers:** there is no timer, cron or polling loop. BullMQ delayed jobs do all the waiting.

### Rate-limit semantics

- **What consumes a slot:** a successful reservation, made **before** SMTP. Slots are never refunded. A rejected email, a crash after reservation, or a cancelled email still counts for that window, which is conservative.
- **Crash after reservation:** the reservation is kept per email (`rl:{s:<senderId>}:resv:<emailId>`, idempotent). When the job re-runs it reuses its own slot and is not counted twice.
- **Late jobs:** if a job runs after its slot's window has ended (e.g. after an outage), the stale reservation is dropped and the email reserves again in the current window, so late sends never exceed a limit.
- **Expiry:** window hashes expire one window after their window ends, reservations one window after their slot, and the gate `delay + 1h` after the last send. Stale rate-limit state therefore cannot block sending permanently.
- **Redis cluster:** sender keys share a `{s:<senderId>}` hash tag. Campaign counters are separate keys; the scripts assume the single Redis instance used here.

### SMTP error classification

`SMTPConnection` (nodemailer) is driven in explicit phases so that failures can be classified by **when** they happened. `transport.sendMail()` hides this, and nodemailer reports socket errors as command `CONN` at every stage.

| Failure | Result | Why |
|---|---|---|
| connect / TLS / greeting / DNS / connection refused, AUTH failure | `FAILED` | nothing has been sent yet |
| `EENVELOPE` (MAIL FROM / RCPT TO / DATA command rejected, invalid address) | `FAILED` | the message body was never transmitted |
| `EMESSAGE` with an SMTP reply code (e.g. `554` after the body) | `FAILED` | the server explicitly refused the message |
| socket closed/reset, timeout, protocol error during the send phase, or a worker crash after `delivery_started_at` | `DELIVERY_UNKNOWN` | the server may have accepted the message |

Assumption: a server that answers the message with 4xx/5xx did not accept it. Transient 4xx rejections are marked `FAILED` rather than retried; retrying them would be safe (the message was not accepted) and could be added later.

### Ordering

- **Scheduling order:** emails are enqueued in `scheduled_at` order (BullMQ runs equal-time jobs in insertion order; reconciliation pages by `(scheduled_at, id)`), and reservations are first come, first served.
- **Concurrency 1:** scheduling order is preserved exactly, including across rate-limit rescheduling (the rescheduled emails get increasing slots in the next window).
- **Concurrency > 1:** emails that become due at the same moment are reserved in whatever order the concurrently active jobs reach Redis. This reordering is bounded by `WORKER_CONCURRENCY × number of workers`. **There is no strict global ordering guarantee.** A strict first-in-first-out gate was rejected because, with bounded concurrency, active jobs could wait forever for an earlier email that is still queued behind them.

### Restart behavior

All coordination state (counters, cursors, reservations, gate) is in Redis, and all email state is in PostgreSQL. Restarting workers changes nothing: the delay and the counts continue where they were, and delayed jobs survive in Redis (AOF). On start, each worker runs one reconciliation pass (below).

### 1000+ emails at the same time

Each email is a delayed BullMQ job; nothing loads all emails into memory (reconciliation pages 500 at a time).

When 1000 jobs become due together, each worker processes up to `WORKER_CONCURRENCY` at once:
- each job makes one atomic reservation;
- emails beyond the hourly limit are re-delayed into later windows (one DB write plus one job move each);
- emails within the limit are re-delayed to their spaced slot, or sent after a short in-process wait.

Verified in the test suite: 1000 emails, 3 workers × concurrency 5, limit 400/h, 2 ms delay → exactly 400 sent (minimum gap ≥ 2 ms), 400 rescheduled into the next hour and 200 into the hour after, no duplicates, one `hourlyLimitReached` event, in about 4 s.

### Startup reconciliation

The email row is committed before its job is added, and the two writes are not atomic. When the worker process starts, it runs **one** reconciliation pass (`reconcileEmailJobs`) before it begins processing. The pass has two steps:

1. Resolve orphaned `PROCESSING` claims whose job is no longer live (see below).
2. Make sure every `SCHEDULED` email has its `email-<emailId>` job.

The pass is idempotent. Running it again, or from two workers at once, creates no duplicate jobs. It is not repeated on a timer. `npm run queue:reconcile -w apps/backend` runs the same pass on demand.

### Delivery ambiguity and crash recovery

An SMTP server can accept a message and the worker can then die before PostgreSQL records `SENT`. From the database alone, that looks the same as dying just before the server accepted it. Delivery is therefore **at most once, not exactly once**. Each attempt works like this:

1. **Claim:** `SCHEDULED` → `PROCESSING`, storing a fresh `processing_token`. Every later write for the attempt only applies if the row still has this token.
2. **Mark delivery started:** `delivery_started_at` is written immediately **before** the email is handed to the provider.
3. **Record the outcome:** `SENT`, or `FAILED` for a definitive rejection (`DeliveryRejectedError`), or `DELIVERY_UNKNOWN` for any other error.

A `PROCESSING` email counts as orphaned only when there is evidence nobody holds it any more: either its own job is re-running (a BullMQ retry, or a stalled job after its lock expired), or at startup its job is missing, failed or completed. Orphaned claims are resolved like this:
- `delivery_started_at` **null**: the email was provably never handed over, so it is released to `SCHEDULED` and queued again.
- `delivery_started_at` **set**: the outcome is ambiguous, so the email becomes **`DELIVERY_UNKNOWN`** and is **never retried automatically**. An operator can check the provider for its deterministic `Message-ID` before deciding to resend; there is no automatic resolution.

## Database

Schema: [apps/backend/prisma/schema.prisma](apps/backend/prisma/schema.prisma). Tables: `users`, `senders`, `campaigns`, `emails`, `slack_connections`.

- Tenant isolation is enforced in the database: `emails` reference `campaigns` and `senders` through composite `(id, user_id)` foreign keys.
- SMTP passwords and Slack tokens are stored only as AES-256-GCM ciphertext (`*_encrypted` columns, `src/lib/crypto.ts`, key from `ENCRYPTION_KEY`).
- API responses must use the selects in `src/db/selects.ts`, which omit credential columns.

Backend database commands (run from `apps/backend`):

| Command | Purpose |
|---|---|
| `npm run prisma:migrate` | create/apply migrations in development |
| `npm run prisma:deploy` | apply pending migrations (CI/production) |
| `npm run prisma:validate` | validate the schema |
| `npm run prisma:studio` | browse data |
| `npm run db:verify` | check constraints against the live database (uses throwaway rows, cleans up) |

The generated Prisma client goes to `apps/backend/src/generated/prisma` and is git-ignored.
