-- Head Office requests for products the catalogue does not carry.
--
-- One new, empty table. Nothing existing is rewritten, no backfill runs, and no
-- existing table takes more than the brief catalog lock of a foreign key being
-- added against it.
--
-- A request is information only: approving one creates no product and sets no
-- price. expected_price_cents is what Head Office expects to pay, for Super
-- Admin's information; nothing in the price ladder reads it.
--
-- What the constraints hold, so that no future endpoint can lose them:
--   * the three statuses — nothing can write a fourth;
--   * no negative expected price or monthly quantity;
--   * image_url is a stored image path under /api/v1/images/products/, never a
--     data: URL or an external address;
--   * a pending row carries no decision, and a decided one names who decided
--     it and when, so a request cannot be marked done without a recorded
--     reviewer.
--
-- Every descriptive column is nullable because every field on the form is
-- optional; the route refuses a request with nothing in it at all.
--
-- Rollback:
--   DROP TABLE "product_requests";
-- Nothing else references it.

CREATE TABLE "product_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"status" varchar(32) DEFAULT 'PENDING' NOT NULL,
	"product_name" varchar(255),
	"brand" varchar(255),
	"description" text,
	"category_id" integer,
	"subcategory_id" integer,
	"unit" varchar(64),
	"pack_size" varchar(128),
	"barcode" varchar(64),
	"expected_price_cents" integer,
	"estimated_monthly_quantity" numeric(12, 3),
	"preferred_supplier" varchar(255),
	"reference_url" text,
	"notes" text,
	"image_url" text,
	"review_note" text,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_requests_status_ck" CHECK ("product_requests"."status" IN ('PENDING', 'APPROVED', 'REJECTED')),
	CONSTRAINT "product_requests_values_valid_ck" CHECK (COALESCE("product_requests"."expected_price_cents", 0) >= 0 AND COALESCE("product_requests"."estimated_monthly_quantity", 0) >= 0),
	CONSTRAINT "product_requests_image_path_ck" CHECK ("product_requests"."image_url" IS NULL OR "product_requests"."image_url" LIKE '/api/v1/images/products/%'),
	CONSTRAINT "product_requests_review_ck" CHECK (CASE WHEN "product_requests"."status" = 'PENDING'
            THEN "product_requests"."reviewed_at" IS NULL AND "product_requests"."reviewed_by_user_id" IS NULL AND "product_requests"."review_note" IS NULL
            ELSE "product_requests"."reviewed_at" IS NOT NULL AND "product_requests"."reviewed_by_user_id" IS NOT NULL
          END)
);
--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_subcategory_id_categories_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_requests_org_created_idx" ON "product_requests" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "product_requests_status_created_idx" ON "product_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "product_requests_requester_idx" ON "product_requests" USING btree ("requested_by_user_id");
