-- Self-service joining: an organization's join code, and the requests it lets
-- people raise.
--
-- Two new tables. Nothing existing is altered, so there is no rewrite, no lock
-- on a large table, and no behaviour change for any current caller.
--
-- Why the code is not a column on `organizations`:
--   `GET /api/v1/organizations` and `GET /api/v1/organizations/[id]` both select
--   the whole organization row, and between them admit SUPER_ADMIN, HEAD_OFFICE,
--   BRANCH_ADMIN, GROUP_USER and ORDER_PORTAL. A column there would hand the
--   code to every employee in the tenant on page load. This table is reachable
--   only through /api/v1/organizations/join-code, which admits Head Office.
--
-- What the constraints hold, so that no future endpoint can lose them:
--   * the code's shape (>= 8 characters of [A-Z0-9-]) — the floor on guessing;
--   * one code per organization, and one organization per code;
--   * the four roles the public form may request — HEAD_OFFICE and SUPER_ADMIN
--     are unreachable from this table;
--   * the role/scope shape: a single-branch role names one branch and no id
--     lists, a group role names at least one group or branch and no branch;
--   * a pending request carries no decision, a decided one names its decider,
--     and an approved one names the user it created;
--   * one pending request per email and per username (partial unique indexes),
--     so a duplicate submission is a database error rather than a race.
--
-- A tenant with no row in organization_join_codes cannot be joined at all, so
-- the feature is off until Head Office turns it on, per tenant.
--
-- Rollback:
--   DROP TABLE organization_join_requests;
--   DROP TABLE organization_join_codes;
-- Nothing else references either table.

CREATE TABLE "organization_join_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"code" varchar(64) NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_join_codes_code_shape_ck" CHECK ("organization_join_codes"."code" ~ '^[A-Z0-9-]{8,32}$')
);
--> statement-breakpoint
CREATE TABLE "organization_join_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"requested_role" varchar(32) NOT NULL,
	"requested_branch_id" integer,
	"requested_group_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_branch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"email" varchar(255) NOT NULL,
	"username" varchar(255) NOT NULL,
	"phone" varchar(32),
	"employee_id" varchar(64),
	"imprest_holder" varchar(255),
	"contact_person" varchar(255),
	"location" varchar(255),
	"address" text,
	"password_hash" varchar(255) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"decision_reason" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_user_id" uuid,
	"submitted_ip" varchar(64),
	"submitted_user_agent" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_join_requests_status_ck" CHECK ("organization_join_requests"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "organization_join_requests_role_ck" CHECK ("organization_join_requests"."requested_role" IN ('BRANCH_ADMIN', 'ORDER_PORTAL', 'GROUP_USER', 'GROUP_ORDER_PORTAL')),
	CONSTRAINT "organization_join_requests_scope_shape_ck" CHECK (CASE WHEN "organization_join_requests"."requested_role" IN ('BRANCH_ADMIN', 'ORDER_PORTAL')
            THEN "organization_join_requests"."requested_branch_id" IS NOT NULL
              AND jsonb_array_length("organization_join_requests"."requested_group_ids") = 0
              AND jsonb_array_length("organization_join_requests"."requested_branch_ids") = 0
            ELSE "organization_join_requests"."requested_branch_id" IS NULL
              AND jsonb_array_length("organization_join_requests"."requested_group_ids") + jsonb_array_length("organization_join_requests"."requested_branch_ids") > 0
          END),
	CONSTRAINT "organization_join_requests_decision_ck" CHECK (CASE WHEN "organization_join_requests"."status" = 'pending'
            THEN "organization_join_requests"."decided_at" IS NULL AND "organization_join_requests"."decided_by_user_id" IS NULL AND "organization_join_requests"."created_user_id" IS NULL
            ELSE "organization_join_requests"."decided_at" IS NOT NULL AND "organization_join_requests"."decided_by_user_id" IS NOT NULL
          END),
	CONSTRAINT "organization_join_requests_approved_user_ck" CHECK ("organization_join_requests"."status" <> 'approved' OR "organization_join_requests"."created_user_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "organization_join_codes" ADD CONSTRAINT "organization_join_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_codes" ADD CONSTRAINT "organization_join_codes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_codes" ADD CONSTRAINT "organization_join_codes_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD CONSTRAINT "organization_join_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD CONSTRAINT "organization_join_requests_requested_branch_id_branches_id_fk" FOREIGN KEY ("requested_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD CONSTRAINT "organization_join_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD CONSTRAINT "organization_join_requests_created_user_id_users_id_fk" FOREIGN KEY ("created_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_join_codes_org_uq" ON "organization_join_codes" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_join_codes_code_uq" ON "organization_join_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "organization_join_requests_org_status_idx" ON "organization_join_requests" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "organization_join_requests_created_user_idx" ON "organization_join_requests" USING btree ("created_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_join_requests_pending_email_uq" ON "organization_join_requests" USING btree ("organization_id","email") WHERE "organization_join_requests"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "organization_join_requests_pending_username_uq" ON "organization_join_requests" USING btree ("organization_id","username") WHERE "organization_join_requests"."status" = 'pending';