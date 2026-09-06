-- Remember that a fulfilment token was handed to admin operations.
--
-- Handing the token over used to settle the order immediately, which marked
-- orders fulfilled before the goods had arrived. The hand-off is now recorded
-- here and the order is settled when its delivery status reaches DELIVERED —
-- either straight away, when it was already delivered, or at the moment the
-- Super Admin records delivery.
--
-- Both columns are nullable with no default, so every existing order keeps
-- exactly the data it has and no code path is forced to supply one. Orders
-- already fulfilled through the old immediate hand-off are deliberately left
-- alone: they are settled, and nothing re-reads these columns for them.
-- Idempotent: safe to re-run.
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "token_handoff_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "token_handoff_by_user_id" uuid;
--> statement-breakpoint

-- The sender is a user of this platform, so the reference is enforced the same
-- way every other actor column on the order is.
DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "orders_token_handoff_by_user_id_users_id_fk" FOREIGN KEY ("token_handoff_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
