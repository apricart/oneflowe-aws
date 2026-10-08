-- Apricart Executives approve Order Desk orders.
-- See plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md.
--
-- Additive only:
--
--   * apricart_executive_assignments — which organizations each Apricart
--     Executive approves Order Desk orders for. New and empty: no executive
--     decides anything until a Super Admin assigns an organization.
--   * order_correction_requests_resolution_ck admits 'CANCELLED', for a
--     returned desk order the desk withdrew instead of resubmitting. The new
--     check is a superset of the old one, so every existing row passes; the
--     table is small and the re-validation scan is brief.
--
-- No backfill. Desk orders created before this change keep their status.
--
-- Apply before deploying: the order-decision policy reads the new table.
--
-- Rollback (after deploying code that no longer reads the table, and only
-- once no correction round holds 'CANCELLED'):
--   DROP TABLE IF EXISTS "apricart_executive_assignments";
--   ALTER TABLE "order_correction_requests" DROP CONSTRAINT "order_correction_requests_resolution_ck";
--   ALTER TABLE "order_correction_requests" ADD CONSTRAINT "order_correction_requests_resolution_ck"
--     CHECK ("resolution" IS NULL OR "resolution" IN ('RESUBMITTED', 'REJECTED'));

CREATE TABLE IF NOT EXISTS "apricart_executive_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" integer NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "apricart_executive_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "apricart_executive_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apricart_executive_assignments_user_org_uq" ON "apricart_executive_assignments" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apricart_executive_assignments_org_idx" ON "apricart_executive_assignments" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "order_correction_requests" DROP CONSTRAINT IF EXISTS "order_correction_requests_resolution_ck";--> statement-breakpoint
ALTER TABLE "order_correction_requests" ADD CONSTRAINT "order_correction_requests_resolution_ck" CHECK ("order_correction_requests"."resolution" IS NULL OR "order_correction_requests"."resolution" IN ('RESUBMITTED', 'REJECTED', 'CANCELLED'));
