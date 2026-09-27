import { env } from '../config/env.js';

// Slack OAuth v2 ("Add to Slack") and the two Web API calls we need.
//
// Scope: only `incoming-webhook`. During consent the user picks the channel;
// Slack returns a bot token plus an incoming-webhook URL for that channel.
// Notifications are posted to the webhook; the token is kept (encrypted) only
// so that disconnect can revoke it.

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  apiBaseUrl: string;
  // Hosts a webhook URL may point to. A stored URL on any other host is refused,
  // so a tampered row cannot make the worker post data elsewhere.
  webhookHosts: string[];
}

export const SLACK_SCOPES = ['incoming-webhook'];

export const SLACK_ENDPOINTS = {
  authorizeUrl: 'https://slack.com/oauth/v2/authorize',
  apiBaseUrl: 'https://slack.com/api',
  webhookHosts: ['hooks.slack.com'],
};

export function slackConfigFromEnv(): SlackOAuthConfig | null {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) return null;
  return {
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
    redirectUri: env.SLACK_REDIRECT_URI,
    ...SLACK_ENDPOINTS,
    webhookHosts: [...SLACK_ENDPOINTS.webhookHosts],
  };
}

export function buildSlackAuthorizeUrl(config: SlackOAuthConfig, state: string): string {
  const url = new URL(config.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    scope: SLACK_SCOPES.join(','),
    redirect_uri: config.redirectUri,
    state,
  }).toString();
  return url.toString();
}

export interface SlackInstallation {
  accessToken: string;
  scope: string | null;
  botUserId: string | null;
  teamId: string;
  teamName: string | null;
  channelId: string | null;
  channelName: string | null;
  webhookUrl: string;
}

export class SlackOAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SlackOAuthError';
  }
}

export function isAllowedWebhookUrl(config: Pick<SlackOAuthConfig, 'webhookHosts'>, value: string): boolean {
  try {
    const url = new URL(value);
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    // https is required, except for an explicitly allow-listed loopback host (tests).
    return config.webhookHosts.includes(url.hostname) && (url.protocol === 'https:' || local);
  } catch {
    return false;
  }
}

export async function exchangeSlackCode(config: SlackOAuthConfig, code: string): Promise<SlackInstallation> {
  let body: Record<string, unknown> | null;
  try {
    const response = await fetch(`${config.apiBaseUrl}/oauth.v2.access`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    throw new SlackOAuthError('token_exchange_failed');
  }
  if (!body || body.ok !== true) throw new SlackOAuthError('token_exchange_failed');

  const team = body.team as { id?: unknown; name?: unknown } | undefined;
  const hook = body.incoming_webhook as { url?: unknown; channel?: unknown; channel_id?: unknown } | undefined;
  if (typeof body.access_token !== 'string' || typeof team?.id !== 'string') {
    throw new SlackOAuthError('invalid_oauth_response');
  }
  if (typeof hook?.url !== 'string' || !isAllowedWebhookUrl(config, hook.url)) {
    throw new SlackOAuthError('invalid_oauth_response');
  }
  return {
    accessToken: body.access_token,
    scope: typeof body.scope === 'string' ? body.scope : null,
    botUserId: typeof body.bot_user_id === 'string' ? body.bot_user_id : null,
    teamId: team.id,
    teamName: typeof team.name === 'string' ? team.name : null,
    channelId: typeof hook.channel_id === 'string' ? hook.channel_id : null,
    channelName: typeof hook.channel === 'string' ? hook.channel : null,
    webhookUrl: hook.url,
  };
}

// Best effort: revokes the token at Slack. Returns whether Slack confirmed it.
export async function revokeSlackToken(config: Pick<SlackOAuthConfig, 'apiBaseUrl'>, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${config.apiBaseUrl}/auth.revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
    // Already invalid tokens count as revoked.
    return body?.ok === true || body?.error === 'invalid_auth' || body?.error === 'token_revoked';
  } catch {
    return false;
  }
}

export type WebhookResult =
  | { kind: 'ok' }
  | { kind: 'revoked'; reason: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'retry'; reason: string };

// Slack error bodies that mean this webhook/token will never work again.
const REVOKED_ERRORS = new Set([
  'invalid_token',
  'no_service',
  'no_service_id',
  'no_team',
  'team_disabled',
  'channel_not_found',
  'channel_is_archived',
  'action_prohibited',
  'token_revoked',
]);

export async function postToWebhook(url: string, payload: unknown): Promise<WebhookResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { kind: 'retry', reason: err instanceof Error ? err.name : 'network_error' };
  }
  const text = (await response.text().catch(() => '')).trim().slice(0, 100);
  if (response.ok) return { kind: 'ok' };
  if (REVOKED_ERRORS.has(text) || response.status === 403 || response.status === 404 || response.status === 410) {
    return { kind: 'revoked', reason: text || `http_${response.status}` };
  }
  if (response.status === 429 || response.status >= 500) {
    return { kind: 'retry', reason: text || `http_${response.status}` };
  }
  return { kind: 'rejected', reason: text || `http_${response.status}` };
}
