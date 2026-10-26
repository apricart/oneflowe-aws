-- The Finance role: Apricart finance staff who read orders and reports in the
-- organizations assigned to them, and mark orders Paid or Unpaid.
-- See plans/OF-FINANCE-finance-role.md.
--
-- Additive only:
--
--   * the FINANCE row in roles. Inserted here rather than by running the
--     general seed against production (the seed rewrites role_permissions),
--     as the other Apricart roles' were.
--   * finance_organization_assignments — which organizations each Finance
--     account reads. New and empty: a Finance account reads nothing until
--     Super Admin assigns an organization.
--
-- No backfill. Apply before deploying: creating a Finance account needs the
-- role row, and every Finance read selects the new table.
--
-- Rollback (after deactivating every Finance account and deploying code that
-- no longer reads the table):
--   DROP TABLE IF EXISTS "finance_organization_assignments";
--   DELETE FROM "roles" WHERE "name" = 'FINANCE' AND NOT EXISTS (
--     SELECT 1 FROM "users" WHERE "users"."role_id" = "roles"."id");

INSERT INTO "roles" ("name", "description")
SELECT 'FINANCE', 'Apricart finance: reads orders and reports for its assigned organizations, marks orders paid or unpaid'
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "name" = 'FINANCE');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finance_organization_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" integer NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "finance_organization_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "finance_organization_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finance_organization_assignments_user_org_uq" ON "finance_organization_assignments" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_organization_assignments_org_idx" ON "finance_organization_assignments" USING btree ("organization_id");
