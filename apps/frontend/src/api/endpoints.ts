import type {
  Campaign,
  CreateCampaignRequest,
  CreateCampaignResponse,
  CreateSenderRequest,
  EmailDetail,
  EmailStatus,
  ParsedRecipientsResponse,
  SearchResponse,
  Sender,
  SlackStatus,
  User,
} from '../types/api';
import { request } from './client';

// Typed wrappers for every backend endpoint the UI uses.

export const authApi = {
  me: (signal?: AbortSignal) => request<User>('/auth/me', { signal }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  // Full-page navigation: the backend runs the Google OAuth redirect flow.
  googleLoginUrl: (returnTo = '/scheduled') => `/auth/google?returnTo=${encodeURIComponent(returnTo)}`,
};

export interface EmailSearchParams {
  q?: string;
  status: EmailStatus[];
  page: number;
  limit: number;
  sort: 'scheduledAt' | 'sentAt' | 'createdAt' | 'relevance';
  order: 'asc' | 'desc';
}

export const emailsApi = {
  search: (p: EmailSearchParams, signal?: AbortSignal) =>
    request<SearchResponse>('/api/emails/search', {
      signal,
      query: { q: p.q?.trim() || undefined, status: p.status.join(','), page: p.page, limit: p.limit, sort: p.sort, order: p.order },
    }),
  get: (id: string, signal?: AbortSignal) => request<EmailDetail>(`/api/emails/${id}`, { signal }),
};

export const campaignsApi = {
  create: (body: CreateCampaignRequest) => request<CreateCampaignResponse>('/api/campaigns', { method: 'POST', body }),
  parseRecipients: (text: string) =>
    request<ParsedRecipientsResponse>('/api/campaigns/recipients/parse', { method: 'POST', body: { text } }),
  list: (signal?: AbortSignal) => request<Campaign[]>('/api/campaigns', { signal }),
  cancel: (id: string) => request<{ cancelledEmails: number }>(`/api/campaigns/${id}/cancel`, { method: 'POST' }),
};

export const sendersApi = {
  list: (signal?: AbortSignal) => request<Sender[]>('/api/senders', { signal }),
  create: (body: CreateSenderRequest) => request<Sender>('/api/senders', { method: 'POST', body }),
  createEthereal: (hourlyLimit: number) => request<Sender>('/api/senders/ethereal', { method: 'POST', body: { hourlyLimit } }),
  update: (id: string, body: Partial<CreateSenderRequest> & { isActive?: boolean }) =>
    request<Sender>(`/api/senders/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => request<{ outcome: 'deleted' | 'deactivated' }>(`/api/senders/${id}`, { method: 'DELETE' }),
};

export const slackApi = {
  status: (signal?: AbortSignal) => request<SlackStatus>('/slack/status', { signal }),
  connectUrl: (returnTo = '/settings') => `/slack/connect?returnTo=${encodeURIComponent(returnTo)}`,
  disconnect: () => request<{ status: string; revoked: boolean }>('/slack/disconnect', { method: 'POST' }),
};
