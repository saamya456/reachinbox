-- AlterTable
ALTER TABLE "slack_connections" ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "last_notified_at" TIMESTAMPTZ(3),
ADD COLUMN     "webhook_url_encrypted" TEXT;
