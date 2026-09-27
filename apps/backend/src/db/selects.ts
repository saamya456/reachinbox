import type { Prisma } from '../generated/prisma/client.js';

// Selects for data returned through the API. They deliberately omit
// credential columns (smtpPasswordEncrypted, accessTokenEncrypted), so
// secrets cannot leak through a response even in encrypted form.

export const publicUserSelect = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export const publicSenderSelect = {
  id: true,
  email: true,
  displayName: true,
  smtpHost: true,
  smtpPort: true,
  smtpSecure: true,
  smtpUser: true,
  isActive: true,
  hourlyLimit: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SenderSelect;

export const publicCampaignSelect = {
  id: true,
  subject: true,
  body: true,
  startAt: true,
  delayBetweenEmailsMs: true,
  hourlyLimit: true,
  status: true,
  totalEmails: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CampaignSelect;

export const publicEmailSelect = {
  id: true,
  campaignId: true,
  senderId: true,
  recipientEmail: true,
  subject: true,
  status: true,
  scheduledAt: true,
  originalScheduledAt: true,
  rescheduleCount: true,
  attempts: true,
  sentAt: true,
  previewUrl: true,
  errorMessage: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.EmailSelect;

export const publicSlackConnectionSelect = {
  id: true,
  teamId: true,
  teamName: true,
  channelId: true,
  channelName: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SlackConnectionSelect;

export type PublicUser = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;
export type PublicSender = Prisma.SenderGetPayload<{ select: typeof publicSenderSelect }>;
export type PublicCampaign = Prisma.CampaignGetPayload<{ select: typeof publicCampaignSelect }>;
export type PublicEmail = Prisma.EmailGetPayload<{ select: typeof publicEmailSelect }>;
export type PublicSlackConnection = Prisma.SlackConnectionGetPayload<{
  select: typeof publicSlackConnectionSelect;
}>;
