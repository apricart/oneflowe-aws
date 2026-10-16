-- Branch head count, set by administrators or requested by the branch.
-- See plans/OF-BRANCH-head-count.md.
--
-- Additive only. branches.head_count is nullable with no default, so adding it
-- does not rewrite the table and every existing branch reads "not provided".
-- The request table is new and empty, so its checks are created valid.
--
-- Apply before deploying: the branch reads select head_count.
--
-- Rollback (after reverting the code that reads them):
--   DROP TABLE IF EXISTS "branch_head_count_requests";
--   ALTER TABLE "branches" DROP CONSTRAINT IF EXISTS "branches_head_count_ck";
--   ALTER TABLE "branches" DROP COLUMN IF EXISTS "head_count";

ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "head_count" integer;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "branches" ADD CONSTRAINT "branches_head_count_ck"
    CHECK ("head_count" IS NULL OR "head_count" BETWEEN 0 AND 1000000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "branch_head_count_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"requested_head_count" integer NOT NULL,
	"current_head_count" integer,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"request_reason" text,
	"requested_by_user_id" uuid NOT NULL,
	"applied_previous_head_count" integer,
	"decision_reason" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_head_count_requests_status_ck" CHECK ("branch_head_count_requests"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "branch_head_count_requests_decision_ck" CHECK (CASE WHEN "branch_head_count_requests"."status" = 'pending'
            THEN "branch_head_count_requests"."decided_at" IS NULL AND "branch_head_count_requests"."decided_by_user_id" IS NULL
            ELSE "branch_head_count_requests"."decided_at" IS NOT NULL AND "branch_head_count_requests"."decided_by_user_id" IS NOT NULL
          END),
	CONSTRAINT "branch_head_count_requests_count_ck" CHECK ("branch_head_count_requests"."requested_head_count" BETWEEN 0 AND 1000000)
);
--> statement-breakpoint
ALTER TABLE "branch_head_count_requests" ADD CONSTRAINT "branch_head_count_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_head_count_requests" ADD CONSTRAINT "branch_head_count_requests_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_head_count_requests" ADD CONSTRAINT "branch_head_count_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_head_count_requests" ADD CONSTRAINT "branch_head_count_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_head_count_requests" ADD CONSTRAINT "branch_head_count_requests_branch_org_fk" FOREIGN KEY ("branch_id", "organization_id") REFERENCES "public"."branches"("id", "organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "branch_head_count_requests_org_status_idx" ON "branch_head_count_requests" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "branch_head_count_requests_branch_status_idx" ON "branch_head_count_requests" USING btree ("branch_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "branch_head_count_requests_requested_by_idx" ON "branch_head_count_requests" USING btree ("requested_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "branch_head_count_requests_pending_uq" ON "branch_head_count_requests" USING btree ("branch_id") WHERE "branch_head_count_requests"."status" = 'pending';
