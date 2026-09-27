-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "search_version" BIGINT NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "search_outbox" (
    "id" BIGSERIAL NOT NULL,
    "email_id" UUID NOT NULL,
    "version" BIGINT NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "search_outbox_email_id_idx" ON "search_outbox"("email_id");

-- ---------------------------------------------------------------------------
-- Hand-written: Elasticsearch outbox triggers (Prisma cannot express triggers).
--
-- Any change to a searchable/state column of an email bumps search_version and
-- records an outbox row IN THE SAME TRANSACTION, so an index update can never
-- be lost between PostgreSQL and the queue. pg_notify (delivered on commit)
-- wakes the relay in the worker process; the outbox row stays until
-- Elasticsearch has applied it.
-- ---------------------------------------------------------------------------

CREATE FUNCTION emails_bump_search_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_version := OLD.search_version + 1;
  RETURN NEW;
END
$$;

CREATE TRIGGER emails_bump_search_version
BEFORE UPDATE ON "emails"
FOR EACH ROW
WHEN (
  (OLD.recipient_email, OLD.subject, OLD.body, OLD.status, OLD.scheduled_at, OLD.sent_at,
   OLD.provider_message_id, OLD.preview_url, OLD.reschedule_count, OLD.error_code)
  IS DISTINCT FROM
  (NEW.recipient_email, NEW.subject, NEW.body, NEW.status, NEW.scheduled_at, NEW.sent_at,
   NEW.provider_message_id, NEW.preview_url, NEW.reschedule_count, NEW.error_code)
)
EXECUTE FUNCTION emails_bump_search_version();

CREATE FUNCTION emails_record_search_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  outbox_id BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO "search_outbox" (email_id, version, deleted)
    VALUES (OLD.id, OLD.search_version + 1, true)
    RETURNING id INTO outbox_id;
    PERFORM pg_notify('email_search_outbox', outbox_id::text);
    RETURN OLD;
  END IF;
  INSERT INTO "search_outbox" (email_id, version)
  VALUES (NEW.id, NEW.search_version)
  RETURNING id INTO outbox_id;
  PERFORM pg_notify('email_search_outbox', outbox_id::text);
  RETURN NEW;
END
$$;

CREATE TRIGGER emails_search_outbox_insert
AFTER INSERT ON "emails"
FOR EACH ROW EXECUTE FUNCTION emails_record_search_outbox();

CREATE TRIGGER emails_search_outbox_update
AFTER UPDATE ON "emails"
FOR EACH ROW
WHEN (OLD.search_version IS DISTINCT FROM NEW.search_version)
EXECUTE FUNCTION emails_record_search_outbox();

CREATE TRIGGER emails_search_outbox_delete
AFTER DELETE ON "emails"
FOR EACH ROW EXECUTE FUNCTION emails_record_search_outbox();
