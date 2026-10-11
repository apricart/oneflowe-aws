-- Order Desk, second part: the screenshot of the customer's message, and
-- cancelling a desk order before delivery.
-- See plans/OF-ORDER-DESK-internal-order-entry.md.
--
-- Additive only; every column is nullable, so every existing order is unchanged.
--
--   * orders.intake_attachment_key — the private storage key of the WhatsApp /
--     email screenshot. Shape-checked to the `order-intake/` prefix (never a
--     URL, never a data: URL), and unique, so one upload belongs to one order.
--   * orders.cancelled_at / cancelled_by_user_id / cancellation_reason — who
--     withdrew a desk order before delivery, and why. The status itself is the
--     existing CANCELLED, which every report already buckets.
--
-- All four columns are new, so every existing row is NULL and the CHECK and the
-- partial unique index have nothing to reject.
--
-- Apply after 20261005120000_add_order_desk and before deploying.
--
-- Rollback (after clearing any desk screenshots and cancellations you keep):
--   DROP INDEX "orders_intake_attachment_key_uq";
--   ALTER TABLE "orders" DROP CONSTRAINT "orders_intake_attachment_key_ck";
--   ALTER TABLE "orders" DROP COLUMN "cancellation_reason";
--   ALTER TABLE "orders" DROP COLUMN "cancelled_by_user_id";
--   ALTER TABLE "orders" DROP COLUMN "cancelled_at";
--   ALTER TABLE "orders" DROP COLUMN "intake_attachment_key";

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "intake_attachment_key" varchar(128);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelled_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_intake_attachment_key_ck" CHECK ("orders"."intake_attachment_key" IS NULL OR "orders"."intake_attachment_key" ~ '^order-intake/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|gif|webp)$');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_intake_attachment_key_uq" ON "orders" USING btree ("intake_attachment_key") WHERE "orders"."intake_attachment_key" IS NOT NULL;
