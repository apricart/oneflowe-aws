-- Branch payment control: Head Office exceptions
-- (plans/OF-PAYMENT-CONTROL-overdue-ordering-block.md).
--
-- Purely additive and re-entrant: one new table, no change to any existing
-- table, no backfill. An existing branch has no row here and is therefore
-- not excepted from anything; and because no overdue-payment source is
-- connected yet, nothing is blocked either. Rolling the application back
-- leaves an unused table.
--
-- Whether an exception is in force is never stored: it is
--   revoked_at IS NULL AND start_at <= now() AND now() < expires_at
-- computed on every read. expires_at is NOT NULL because an exception is
-- never permanent. The partial index serves the "latest live exception for
-- this branch" lookup the order transaction performs.
--
-- The table starts empty, so the indexes are created inline rather than
-- concurrently.

CREATE TABLE IF NOT EXISTS "payment_control_exceptions" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL,
  "branch_id" integer NOT NULL,
  "granted_by_user_id" uuid NOT NULL,
  "reason" text,
  "start_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by_user_id" uuid,
  "revoke_reason" text,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "payment_control_exceptions_window_ck" CHECK ("expires_at" > "start_at")
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_control_exceptions_organization_id_organizations_id_fk') THEN
    ALTER TABLE "payment_control_exceptions" ADD CONSTRAINT "payment_control_exceptions_organization_id_organizations_id_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_control_exceptions_branch_id_branches_id_fk') THEN
    ALTER TABLE "payment_control_exceptions" ADD CONSTRAINT "payment_control_exceptions_branch_id_branches_id_fk"
      FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_control_exceptions_granted_by_user_id_users_id_fk') THEN
    ALTER TABLE "payment_control_exceptions" ADD CONSTRAINT "payment_control_exceptions_granted_by_user_id_users_id_fk"
      FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_control_exceptions_revoked_by_user_id_users_id_fk') THEN
    ALTER TABLE "payment_control_exceptions" ADD CONSTRAINT "payment_control_exceptions_revoked_by_user_id_users_id_fk"
      FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_control_exceptions_org_idx" ON "payment_control_exceptions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_control_exceptions_live_branch_idx" ON "payment_control_exceptions" USING btree ("branch_id", "expires_at") WHERE "revoked_at" IS NULL;
