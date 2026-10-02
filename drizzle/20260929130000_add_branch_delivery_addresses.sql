-- Multiple delivery addresses per branch, gated on Head Office approval.
--
-- One new table and one nullable column. Nothing existing is rewritten, no
-- backfill runs, and no current caller changes behaviour:
--   * adding a nullable integer column with no default is a catalog-only change
--     on modern Postgres, so `orders` is not rewritten and the ACCESS EXCLUSIVE
--     lock is held for the length of that catalog update, not a table scan;
--   * `orders.delivery_address_id` is NULL on every existing row, which is what
--     every reader already renders as "the branch's own address".
--
-- Why the request and the address are one row rather than two tables:
--   the id an order records is the id Head Office approved. Split across a
--   "request" table and an "address" table, those become two records that can
--   disagree about what was approved; here they cannot.
--
-- What the constraints hold, so that no future endpoint can lose them:
--   * the three statuses — nothing can write a fourth;
--   * a pending row carries no decision and a decided one names its decider,
--     so an address cannot become usable without a recorded approver;
--   * label, label_key and address are non-empty after trimming;
--   * one live address per name per branch (partial unique on the pending and
--     approved statuses), so a duplicate submission is a database error rather
--     than a race between two readers. A rejected label may be requested again.
--
-- label_key is the normalized spelling of label, written by the server through
-- `deliveryAddressLabelKey`. It exists so the uniqueness index above can be a
-- plain column index, the same reason organization_join_requests.email is
-- stored already lower-cased.
--
-- Rollback:
--   ALTER TABLE "orders" DROP COLUMN "delivery_address_id";
--   DROP TABLE "branch_delivery_addresses";
-- Nothing else references either. An order that recorded an address keeps its
-- receipt snapshot, because the address was snapshotted into receipt_data
-- rather than read live.

CREATE TABLE "branch_delivery_addresses" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"label" varchar(120) NOT NULL,
	"label_key" varchar(120) NOT NULL,
	"address" text NOT NULL,
	"city" varchar(100),
	"province" varchar(100),
	"contact_person" varchar(255),
	"contact_phone" varchar(32),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"request_reason" text,
	"requested_by_user_id" uuid NOT NULL,
	"decision_reason" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_delivery_addresses_status_ck" CHECK ("branch_delivery_addresses"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "branch_delivery_addresses_decision_ck" CHECK (CASE WHEN "branch_delivery_addresses"."status" = 'pending'
            THEN "branch_delivery_addresses"."decided_at" IS NULL AND "branch_delivery_addresses"."decided_by_user_id" IS NULL
            ELSE "branch_delivery_addresses"."decided_at" IS NOT NULL AND "branch_delivery_addresses"."decided_by_user_id" IS NOT NULL
          END),
	CONSTRAINT "branch_delivery_addresses_text_ck" CHECK (length(btrim("branch_delivery_addresses"."label")) > 0 AND length(btrim("branch_delivery_addresses"."label_key")) > 0 AND length(btrim("branch_delivery_addresses"."address")) > 0)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_address_id" integer;--> statement-breakpoint
ALTER TABLE "branch_delivery_addresses" ADD CONSTRAINT "branch_delivery_addresses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_delivery_addresses" ADD CONSTRAINT "branch_delivery_addresses_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_delivery_addresses" ADD CONSTRAINT "branch_delivery_addresses_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_delivery_addresses" ADD CONSTRAINT "branch_delivery_addresses_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "branch_delivery_addresses_branch_status_idx" ON "branch_delivery_addresses" USING btree ("branch_id","status","created_at");--> statement-breakpoint
CREATE INDEX "branch_delivery_addresses_org_status_idx" ON "branch_delivery_addresses" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "branch_delivery_addresses_requested_by_idx" ON "branch_delivery_addresses" USING btree ("requested_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_delivery_addresses_live_label_uq" ON "branch_delivery_addresses" USING btree ("branch_id","label_key") WHERE "branch_delivery_addresses"."status" IN ('pending', 'approved');--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_address_id_branch_delivery_addresses_id_fk" FOREIGN KEY ("delivery_address_id") REFERENCES "public"."branch_delivery_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_delivery_address_idx" ON "orders" USING btree ("delivery_address_id") WHERE "orders"."delivery_address_id" IS NOT NULL;