-- Order approval levels, phase 1: Super Admin switches the feature on or off
-- per organization and defines its levels, each with the amount up to which
-- that level may approve an order.
-- See plans/OF-APPROVAL-LEVELS-organization-approval-levels.md.
--
-- Additive only:
--
--   * organizations.order_approval_levels_enabled — NOT NULL with a constant
--     default, so Postgres records the default in the catalogue rather than
--     rewriting the table. Every existing organization reads false: nothing
--     changes for any tenant.
--   * organization_approval_levels — new and empty. One row per level per
--     organization; cascades with its organization.
--
-- Phase 1 stores configuration only: nothing in the order path reads either
-- object yet. Apply before deploying — the organization POST and
-- /api/v1/organizations/[id]/approval-levels select them.
--
-- Rollback (after reverting the code that reads them):
--   DROP TABLE IF EXISTS "organization_approval_levels";
--   ALTER TABLE "organizations" DROP COLUMN IF EXISTS "order_approval_levels_enabled";

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "order_approval_levels_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_approval_levels" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"level" integer NOT NULL,
	"max_amount_cents" bigint NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "organization_approval_levels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "organization_approval_levels_level_ck" CHECK ("level" BETWEEN 1 AND 10),
	CONSTRAINT "organization_approval_levels_amount_ck" CHECK ("max_amount_cents" BETWEEN 1 AND 100000000000)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_approval_levels_org_level_uq" ON "organization_approval_levels" USING btree ("organization_id","level");
