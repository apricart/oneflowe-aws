-- A delivery challan is required to mark an order delivered.
-- See plans/OF-DELIVERY-CHALLAN-proof-of-delivery.md.
--
-- Additive only: one new table, nothing existing changes. Orders already
-- delivered keep exactly what they have; only new deliveries need a challan.
--
-- Apply before deploying: the progress route attaches the challan in this table.
--
-- Rollback: DROP TABLE "order_delivery_challans";
-- (the S3 objects under delivery-challan/ remain and can be removed separately).

CREATE TABLE IF NOT EXISTS "order_delivery_challans" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"storage_key" varchar(128) NOT NULL,
	"file_name" varchar(160) NOT NULL,
	"content_type" varchar(32) NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attached_at" timestamp with time zone,
	"replaced_at" timestamp with time zone,
	"replaced_by_user_id" uuid,
	CONSTRAINT "order_delivery_challans_key_ck" CHECK ("order_delivery_challans"."storage_key" ~ '^delivery-challan/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp|pdf)$'),
	CONSTRAINT "order_delivery_challans_type_ck" CHECK ("order_delivery_challans"."content_type" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
	CONSTRAINT "order_delivery_challans_size_ck" CHECK ("order_delivery_challans"."size_bytes" > 0 AND "order_delivery_challans"."size_bytes" <= 4194304),
	CONSTRAINT "order_delivery_challans_replace_ck" CHECK (("order_delivery_challans"."replaced_at" IS NULL AND "order_delivery_challans"."replaced_by_user_id" IS NULL) OR ("order_delivery_challans"."replaced_at" IS NOT NULL AND "order_delivery_challans"."replaced_by_user_id" IS NOT NULL AND "order_delivery_challans"."attached_at" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "order_delivery_challans" ADD CONSTRAINT "order_delivery_challans_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_delivery_challans" ADD CONSTRAINT "order_delivery_challans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_delivery_challans" ADD CONSTRAINT "order_delivery_challans_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_delivery_challans" ADD CONSTRAINT "order_delivery_challans_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_delivery_challans" ADD CONSTRAINT "order_delivery_challans_replaced_by_user_id_users_id_fk" FOREIGN KEY ("replaced_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_delivery_challans_storage_key_uq" ON "order_delivery_challans" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_delivery_challans_order_idx" ON "order_delivery_challans" USING btree ("order_id","uploaded_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_delivery_challans_current_uq" ON "order_delivery_challans" USING btree ("order_id") WHERE "order_delivery_challans"."attached_at" IS NOT NULL AND "order_delivery_challans"."replaced_at" IS NULL;
