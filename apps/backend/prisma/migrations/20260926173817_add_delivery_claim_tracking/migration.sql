-- AlterEnum
ALTER TYPE "EmailStatus" ADD VALUE 'DELIVERY_UNKNOWN';

-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "delivery_started_at" TIMESTAMPTZ(3),
ADD COLUMN     "processing_token" UUID;

-- CheckConstraints (hand-written)
-- A claimed email always carries the token of the claim that owns it.
ALTER TABLE "emails" ADD CONSTRAINT "emails_processing_requires_token" CHECK ("status" <> 'PROCESSING' OR "processing_token" IS NOT NULL);
