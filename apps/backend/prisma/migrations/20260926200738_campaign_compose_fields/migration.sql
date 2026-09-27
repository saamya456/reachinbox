-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "client_request_id" TEXT,
ADD COLUMN     "sender_id" UUID,
ADD COLUMN     "timezone" TEXT;
-- CreateIndex
CREATE UNIQUE INDEX "campaigns_user_id_client_request_id_key" ON "campaigns"("user_id", "client_request_id");
-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_sender_id_user_id_fkey" FOREIGN KEY ("sender_id", "user_id") REFERENCES "senders"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
