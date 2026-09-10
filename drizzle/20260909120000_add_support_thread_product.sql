-- The product a support query is about.
--
-- Purely additive: one nullable column, one foreign key, one index. Existing
-- rows are untouched and every read tolerates NULL, so rolling the application
-- back leaves the column unused rather than broken. Guarded throughout, in the
-- style of 20260907120000_add_support_threads.sql, so the migration is
-- re-entrant.
--
-- The referent is "global_products" rather than "organization_products":
-- support_threads already carries its own organization_id, so the pair resolves
-- the tenant's custom name, and the reference survives that tenant later
-- disabling the assignment. ON DELETE SET NULL for the same reason order_id
-- has it — the conversation is the record of what was asked and outlives its
-- subject.

ALTER TABLE "support_threads" ADD COLUMN IF NOT EXISTS "product_id" integer;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_threads_product_id_global_products_id_fk') THEN
    ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_product_id_global_products_id_fk"
      FOREIGN KEY ("product_id") REFERENCES "public"."global_products"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "support_threads_product_idx" ON "support_threads" USING btree ("product_id");
