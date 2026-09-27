// Types of the backend API responses (apps/backend/src/routes/*).

export type EmailStatus = 'SCHEDULED' | 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED' | 'DELIVERY_UNKNOWN';
export type CampaignStatus = 'DRAFT' | 'SCHEDULED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

export interface User {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  isAdmin: boolean;
}

export interface SenderSummary {
  id: string;
  email: string | null;
  displayName: string | null;
}

export interface Sender {
  id: string;
  email: string;
  displayName: string | null;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  isActive: boolean;
  hourlyLimit: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmailListItem {
  id: string;
  recipientEmail: string;
  subject: string;
  snippet: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  createdAt: string;
  rescheduleCount: number;
  previewUrl: string | null;
  errorCode: string | null;
  sender: SenderSummary;
  campaign: { id: string; subject: string | null };
}

export interface SearchResponse {
  items: EmailListItem[];
  page: number;
  limit: number;
  total: number;
}

export interface EmailDetail {
  id: string;
  campaignId: string;
  senderId: string;
  recipientEmail: string;
  subject: string;
  bodyHtml: string;
  status: EmailStatus;
  scheduledAt: string;
  originalScheduledAt: string;
  rescheduleCount: number;
  attempts: number;
  sentAt: string | null;
  providerMessageId: string | null;
  previewUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  sender: SenderSummary;
  campaign: { id: string; subject: string; status: CampaignStatus };
}

export interface RecipientSummary {
  total: number;
  valid: number;
  invalid: number;
  duplicatesRemoved: number;
  invalidEntries: { row: number; value: string }[];
}

export interface ParsedRecipientsResponse extends RecipientSummary {
  emails: string[];
  tooMany: boolean;
}

export interface Campaign {
  id: string;
  subject: string;
  startAt: string;
  timezone: string | null;
  delayBetweenEmailsMs: number;
  hourlyLimit: number;
  status: CampaignStatus;
  totalEmails: number;
  createdAt: string;
  sender: SenderSummary | null;
  emailCounts: Record<EmailStatus, number>;
}

export interface CreateCampaignRequest {
  senderId: string;
  subject: string;
  body: string;
  recipients: string[];
  recipientsText?: string;
  startAt: string;
  timezone: string;
  delayBetweenEmailsSeconds: number;
  hourlyLimit?: number;
  clientRequestId: string;
}

export interface CreateCampaignResponse {
  created: boolean;
  campaign: Campaign;
  recipients: RecipientSummary | null;
  queued: number;
  pendingReconciliation: number;
}

export interface SlackStatus {
  status: 'connected' | 'disconnected' | 'revoked' | 'error';
  configured: boolean;
  teamName?: string | null;
  channelName?: string | null;
  connectedAt?: string;
  lastNotifiedAt?: string | null;
  lastError?: string | null;
}

export interface CreateSenderRequest {
  email: string;
  displayName?: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  hourlyLimit: number;
}
