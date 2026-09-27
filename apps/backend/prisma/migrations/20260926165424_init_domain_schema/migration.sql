-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('SCHEDULED', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SlackConnectionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'ERROR');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "google_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "avatar_url" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "senders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT,
    "smtp_host" TEXT NOT NULL,
    "smtp_port" INTEGER NOT NULL,
    "smtp_secure" BOOLEAN NOT NULL DEFAULT false,
    "smtp_user" TEXT NOT NULL,
    "smtp_password_encrypted" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "hourly_limit" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "senders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "delay_between_emails_ms" INTEGER NOT NULL,
    "hourly_limit" INTEGER NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'SCHEDULED',
    "total_emails" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emails" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "recipient_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "original_scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "reschedule_count" INTEGER NOT NULL DEFAULT 0,
    "last_rescheduled_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "provider_message_id" TEXT,
    "preview_url" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_connections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "team_id" TEXT NOT NULL,
    "team_name" TEXT,
    "channel_id" TEXT,
    "channel_name" TEXT,
    "bot_user_id" TEXT,
    "scope" TEXT,
    "access_token_encrypted" TEXT NOT NULL,
    "status" "SlackConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "slack_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "senders_user_id_is_active_idx" ON "senders"("user_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "senders_id_user_id_key" ON "senders"("id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "senders_user_id_email_key" ON "senders"("user_id", "email");

-- CreateIndex
CREATE INDEX "campaigns_user_id_created_at_idx" ON "campaigns"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "campaigns_user_id_status_idx" ON "campaigns"("user_id", "status");

-- CreateIndex
CREATE INDEX "campaigns_status_start_at_idx" ON "campaigns"("status", "start_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_id_user_id_key" ON "campaigns"("id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "emails_idempotency_key_key" ON "emails"("idempotency_key");

-- CreateIndex
CREATE INDEX "emails_status_scheduled_at_idx" ON "emails"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "emails_user_id_status_scheduled_at_idx" ON "emails"("user_id", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "emails_user_id_sent_at_idx" ON "emails"("user_id", "sent_at" DESC);

-- CreateIndex
CREATE INDEX "emails_campaign_id_status_idx" ON "emails"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "emails_sender_id_sent_at_idx" ON "emails"("sender_id", "sent_at");

-- CreateIndex
CREATE INDEX "emails_sender_id_status_scheduled_at_idx" ON "emails"("sender_id", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "slack_connections_user_id_status_idx" ON "slack_connections"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "slack_connections_user_id_team_id_key" ON "slack_connections"("user_id", "team_id");

-- AddForeignKey
ALTER TABLE "senders" ADD CONSTRAINT "senders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_campaign_id_user_id_fkey" FOREIGN KEY ("campaign_id", "user_id") REFERENCES "campaigns"("id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_sender_id_user_id_fkey" FOREIGN KEY ("sender_id", "user_id") REFERENCES "senders"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_connections" ADD CONSTRAINT "slack_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraints (hand-written; Prisma schema cannot express these)
ALTER TABLE "senders" ADD CONSTRAINT "senders_hourly_limit_positive" CHECK ("hourly_limit" > 0);
ALTER TABLE "senders" ADD CONSTRAINT "senders_smtp_port_range" CHECK ("smtp_port" BETWEEN 1 AND 65535);

ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_hourly_limit_positive" CHECK ("hourly_limit" > 0);
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_delay_non_negative" CHECK ("delay_between_emails_ms" >= 0);
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_total_emails_non_negative" CHECK ("total_emails" >= 0);

ALTER TABLE "emails" ADD CONSTRAINT "emails_attempts_non_negative" CHECK ("attempts" >= 0);
ALTER TABLE "emails" ADD CONSTRAINT "emails_reschedule_count_non_negative" CHECK ("reschedule_count" >= 0);
ALTER TABLE "emails" ADD CONSTRAINT "emails_sent_requires_sent_at" CHECK ("status" <> 'SENT' OR "sent_at" IS NOT NULL);
