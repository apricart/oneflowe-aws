-- Repair schema objects that are present in the Drizzle schema/snapshots but
-- were never created by a journaled SQL migration. This migration is additive
-- and idempotent so it is safe for both rebuilt test databases and production.
ALTER TABLE "branches"
  ADD COLUMN IF NOT EXISTS "baseline_budget_cents" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget_addons" (
	"id" serial PRIMARY KEY NOT NULL,
	"budget_id" integer NOT NULL,
	"amount_cents" bigint NOT NULL,
	"reason" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "budget_addons_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "budget_addons_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_addons_budget_idx" ON "budget_addons" USING btree ("budget_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"user_id" uuid NOT NULL,
	"report_name" varchar(255) NOT NULL,
	"frequency" varchar(32) NOT NULL,
	"format" varchar(16) NOT NULL,
	"emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "scheduled_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "scheduled_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_reports_user_idx" ON "scheduled_reports" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_reports_org_idx" ON "scheduled_reports" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_reports_enabled_idx" ON "scheduled_reports" USING btree ("enabled");
--> statement-breakpoint
ALTER TABLE "budget_addons" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "scheduled_reports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "budget_addons", "scheduled_reports" FROM anon;
    REVOKE ALL ON SEQUENCE "budget_addons_id_seq", "scheduled_reports_id_seq" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "budget_addons", "scheduled_reports" FROM authenticated;
    REVOKE ALL ON SEQUENCE "budget_addons_id_seq", "scheduled_reports_id_seq" FROM authenticated;
  END IF;
END $$;
