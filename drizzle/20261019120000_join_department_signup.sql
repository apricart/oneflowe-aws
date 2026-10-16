-- Department sign-up: the join form for organizations with order approval
-- levels on. See plans/OF-JOIN-department-signup-multi-user.md.
--
-- Additive, except one replaced check constraint. Every new column is nullable
-- or carries a constant default, so no table is rewritten; every existing join
-- request is form_version 1 and passes the replaced check unchanged.
--
-- Rollback (after reverting the code that reads these):
--   DROP TABLE IF EXISTS "organization_join_request_addresses";
--   DROP TABLE IF EXISTS "organization_join_request_approvers";
--   DROP TABLE IF EXISTS "organization_join_request_branches";
--   ALTER TABLE "organization_join_requests" DROP CONSTRAINT IF EXISTS "organization_join_requests_form_version_ck";
--   ALTER TABLE "organization_join_requests" DROP CONSTRAINT IF EXISTS "organization_join_requests_scope_shape_ck";
--   ALTER TABLE "organization_join_requests" ADD CONSTRAINT "organization_join_requests_scope_shape_ck" CHECK (<the 20260929120000 rule>);
--   ALTER TABLE "organization_join_requests" DROP COLUMN IF EXISTS "form_version", DROP COLUMN IF EXISTS "department",
--     DROP COLUMN IF EXISTS "ip_extension", DROP COLUMN IF EXISTS "terms_accepted_at", DROP COLUMN IF EXISTS "approval_levels_snapshot";
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "department", DROP COLUMN IF EXISTS "designation", DROP COLUMN IF EXISTS "ip_extension";
-- (Reject any pending version 2 request first: the old check refuses it.)

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "department" varchar(80);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "designation" varchar(80);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ip_extension" varchar(16);--> statement-breakpoint

ALTER TABLE "organization_join_requests" ADD COLUMN IF NOT EXISTS "form_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD COLUMN IF NOT EXISTS "department" varchar(80);--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD COLUMN IF NOT EXISTS "ip_extension" varchar(16);--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD COLUMN IF NOT EXISTS "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD COLUMN IF NOT EXISTS "approval_levels_snapshot" jsonb;--> statement-breakpoint

ALTER TABLE "organization_join_requests" DROP CONSTRAINT IF EXISTS "organization_join_requests_scope_shape_ck";--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD CONSTRAINT "organization_join_requests_scope_shape_ck" CHECK (CASE WHEN "organization_join_requests"."form_version" = 2
            THEN "organization_join_requests"."requested_role" IN ('ORDER_PORTAL', 'GROUP_ORDER_PORTAL')
              AND jsonb_array_length("organization_join_requests"."requested_group_ids") = 0
          WHEN "organization_join_requests"."requested_role" IN ('BRANCH_ADMIN', 'ORDER_PORTAL')
            THEN "organization_join_requests"."requested_branch_id" IS NOT NULL
              AND jsonb_array_length("organization_join_requests"."requested_group_ids") = 0
              AND jsonb_array_length("organization_join_requests"."requested_branch_ids") = 0
            ELSE "organization_join_requests"."requested_branch_id" IS NULL
              AND jsonb_array_length("organization_join_requests"."requested_group_ids") + jsonb_array_length("organization_join_requests"."requested_branch_ids") > 0
          END);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "organization_join_requests" ADD CONSTRAINT "organization_join_requests_form_version_ck"
    CHECK ("organization_join_requests"."form_version" IN (1, 2));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "organization_join_request_branches" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"existing_branch_id" integer,
	"cost_center_id" varchar(64),
	"resolved_branch_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_join_request_branches_shape_ck" CHECK (("organization_join_request_branches"."existing_branch_id" IS NULL) <> ("organization_join_request_branches"."cost_center_id" IS NULL)
        AND ("organization_join_request_branches"."cost_center_id" IS NULL OR length(btrim("organization_join_request_branches"."cost_center_id")) > 0))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_join_request_approvers" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"level" integer NOT NULL,
	"email" varchar(255) NOT NULL,
	"designation" varchar(80) NOT NULL,
	"resolution" varchar(16),
	"approver_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_join_request_approvers_level_ck" CHECK ("organization_join_request_approvers"."level" BETWEEN 1 AND 10),
	CONSTRAINT "organization_join_request_approvers_resolution_ck" CHECK ("organization_join_request_approvers"."resolution" IS NULL OR "organization_join_request_approvers"."resolution" IN ('created', 'assigned', 'extended', 'covered', 'not_applied'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_join_request_addresses" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"address" varchar(200) NOT NULL,
	"branch_id" integer,
	"delivery_address_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_join_request_addresses_text_ck" CHECK (length(btrim("organization_join_request_addresses"."address")) > 0)
);--> statement-breakpoint

ALTER TABLE "organization_join_request_branches" ADD CONSTRAINT "organization_join_request_branches_request_id_organization_join_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."organization_join_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_request_branches" ADD CONSTRAINT "organization_join_request_branches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_request_branches" ADD CONSTRAINT "organization_join_request_branches_branch_org_fk" FOREIGN KEY ("existing_branch_id","organization_id") REFERENCES "public"."branches"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_request_branches" ADD CONSTRAINT "organization_join_request_branches_resolved_org_fk" FOREIGN KEY ("resolved_branch_id","organization_id") REFERENCES "public"."branches"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_request_approvers" ADD CONSTRAINT "organization_join_request_approvers_request_id_organization_join_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."organization_join_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_request_approvers" ADD CONSTRAINT "organization_join_request_approvers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_request_approvers" ADD CONSTRAINT "organization_join_request_approvers_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_request_addresses" ADD CONSTRAINT "organization_join_request_addresses_request_id_organization_join_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."organization_join_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_request_addresses" ADD CONSTRAINT "organization_join_request_addresses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_request_addresses" ADD CONSTRAINT "organization_join_request_addresses_branch_org_fk" FOREIGN KEY ("branch_id","organization_id") REFERENCES "public"."branches"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_request_addresses" ADD CONSTRAINT "organization_join_request_addresses_delivery_address_id_branch_delivery_addresses_id_fk" FOREIGN KEY ("delivery_address_id") REFERENCES "public"."branch_delivery_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "organization_join_request_branches_request_idx" ON "organization_join_request_branches" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_join_request_branches_existing_uq" ON "organization_join_request_branches" USING btree ("request_id","existing_branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_join_request_branches_crc_uq" ON "organization_join_request_branches" USING btree ("request_id","cost_center_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_join_request_approvers_level_uq" ON "organization_join_request_approvers" USING btree ("request_id","level");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_join_request_approvers_email_uq" ON "organization_join_request_approvers" USING btree ("request_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_join_request_addresses_request_idx" ON "organization_join_request_addresses" USING btree ("request_id");
