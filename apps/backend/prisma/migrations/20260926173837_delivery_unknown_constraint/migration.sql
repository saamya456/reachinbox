-- CheckConstraints (hand-written). Separate migration because PostgreSQL does
-- not allow a new enum value to be used in the transaction that adds it.
-- DELIVERY_UNKNOWN is only valid when a delivery attempt demonstrably started.
ALTER TABLE "emails" ADD CONSTRAINT "emails_delivery_unknown_requires_started" CHECK ("status" <> 'DELIVERY_UNKNOWN' OR "delivery_started_at" IS NOT NULL);
