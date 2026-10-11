-- Return an order to its requester for correction, and resubmit it.
-- See plans/OF-ORDER-RETURN-for-correction.md.
--
-- Additive only.
--
--   * orders.returned_for_correction_at / _by_user_id / correction_request_note
--     — the open correction request, while one is open. The order stays
--     PENDING and keeps its hold; the approve claim refuses while these are set.
--     orders_correction_state_ck: all three or none, and only on a PENDING row.
--   * order_correction_requests — every round, open or closed. One open round
--     per order (partial unique index). Cascades with the order, so the
--     administrative order deletion keeps working unchanged.
--
-- Every new column is NULL on every existing row and the table is new, so no
-- CHECK and no unique index has anything to reject.
--
-- Apply BEFORE deploying: the approve claim names the new column.
--
-- Rollback (any order still returned simply becomes an ordinary pending order):
--   DROP TABLE "order_correction_requests";
--   ALTER TABLE "orders" DROP CONSTRAINT "orders_correction_state_ck";
--   ALTER TABLE "orders" DROP CONSTRAINT "orders_returned_for_correction_by_user_id_users_id_fk";
--   ALTER TABLE "orders" DROP COLUMN "correction_request_note";
--   ALTER TABLE "orders" DROP COLUMN "returned_for_correction_by_user_id";
--   ALTER TABLE "orders" DROP COLUMN "returned_for_correction_at";

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "returned_for_correction_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "returned_for_correction_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "correction_request_note" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_returned_for_correction_by_user_id_users_id_fk" FOREIGN KEY ("returned_for_correction_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_correction_state_ck" CHECK (("orders"."returned_for_correction_at" IS NULL AND "orders"."returned_for_correction_by_user_id" IS NULL AND "orders"."correction_request_note" IS NULL) OR ("orders"."returned_for_correction_at" IS NOT NULL AND "orders"."returned_for_correction_by_user_id" IS NOT NULL AND "orders"."correction_request_note" IS NOT NULL AND UPPER("orders"."status") = 'PENDING'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_correction_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"requested_by_role" varchar(32) NOT NULL,
	"comment" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolution" varchar(16),
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"resolved_by_role" varchar(32),
	"response_note" text,
	CONSTRAINT "order_correction_requests_resolution_ck" CHECK ("order_correction_requests"."resolution" IS NULL OR "order_correction_requests"."resolution" IN ('RESUBMITTED', 'REJECTED')),
	CONSTRAINT "order_correction_requests_shape_ck" CHECK (("order_correction_requests"."resolution" IS NULL AND "order_correction_requests"."resolved_at" IS NULL AND "order_correction_requests"."resolved_by_user_id" IS NULL AND "order_correction_requests"."resolved_by_role" IS NULL AND "order_correction_requests"."response_note" IS NULL) OR ("order_correction_requests"."resolution" IS NOT NULL AND "order_correction_requests"."resolved_at" IS NOT NULL AND "order_correction_requests"."resolved_by_user_id" IS NOT NULL AND "order_correction_requests"."resolved_by_role" IS NOT NULL)),
	CONSTRAINT "order_correction_requests_text_ck" CHECK (char_length(btrim("order_correction_requests"."comment")) BETWEEN 1 AND 1000 AND ("order_correction_requests"."response_note" IS NULL OR char_length("order_correction_requests"."response_note") <= 1000))
);--> statement-breakpoint
ALTER TABLE "order_correction_requests" ADD CONSTRAINT "order_correction_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_correction_requests" ADD CONSTRAINT "order_correction_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_correction_requests" ADD CONSTRAINT "order_correction_requests_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_correction_requests" ADD CONSTRAINT "order_correction_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_correction_requests" ADD CONSTRAINT "order_correction_requests_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_correction_requests_order_idx" ON "order_correction_requests" USING btree ("order_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_correction_requests_open_uq" ON "order_correction_requests" USING btree ("order_id") WHERE "order_correction_requests"."resolution" IS NULL;
