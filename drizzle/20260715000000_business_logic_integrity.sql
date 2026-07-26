ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "idempotency_key" varchar(128);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "request_fingerprint" varchar(64);

DELETE FROM "organization_settings" older
USING "organization_settings" newer
WHERE older."organization_id" = newer."organization_id"
  AND older."key" = newer."key"
  AND older."id" < newer."id";

CREATE UNIQUE INDEX IF NOT EXISTS "organization_settings_org_key_uq"
  ON "organization_settings" ("organization_id", "key");
CREATE UNIQUE INDEX IF NOT EXISTS "orders_creator_idempotency_uq"
  ON "orders" ("created_by_user_id", "idempotency_key");

DO $$
BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_nonnegative_ck"
    CHECK ("subtotal_cents" >= 0 AND "tax_cents" >= 0 AND "total_cents" >= 0
      AND COALESCE("refund_amount_cents", 0) >= 0
      AND COALESCE("refund_amount_cents", 0) <= "total_cents") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "orders_idempotency_pair_ck"
    CHECK (("idempotency_key" IS NULL AND "request_fingerprint" IS NULL)
      OR ("idempotency_key" IS NOT NULL AND "request_fingerprint" IS NOT NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "order_items" ADD CONSTRAINT "order_items_values_valid_ck"
    CHECK ("quantity" > 0 AND "quantity" <= 1000000 AND "price_cents" >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive_ck"
    CHECK ("amount_cents" > 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_values_valid_ck"
    CHECK ("quantity" > 0 AND "quantity" <= 1000000 AND "amount_cents" >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "global_products" ADD CONSTRAINT "global_products_values_valid_ck"
    CHECK ("base_price_cents" >= 0 AND "stock_quantity" >= 0 AND "quantity_step" > 0
      AND COALESCE("discount_value_cents", 0) >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "organization_inventory" ADD CONSTRAINT "organization_inventory_price_valid_ck"
    CHECK ("custom_price_cents" IS NULL OR "custom_price_cents" >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "organization_products" ADD CONSTRAINT "organization_products_price_valid_ck"
    CHECK ("custom_price_cents" IS NULL OR "custom_price_cents" >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "budgets" ADD CONSTRAINT "budgets_values_valid_ck"
    CHECK ("amount_allocated_cents" >= 0 AND "amount_spent_cents" >= 0
      AND "amount_held_cents" >= 0 AND "amount_credited_cents" >= 0
      AND ("amount_allocated_cents" + "amount_credited_cents") >=
          ("amount_spent_cents" + "amount_held_cents")) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "product_quantity_budgets" ADD CONSTRAINT "product_quantity_budgets_values_valid_ck"
    CHECK ("allocated_quantity" >= 0 AND "held_quantity" >= 0 AND "used_quantity" >= 0
      AND "credited_quantity" >= 0 AND "amount_allocated_cents" >= 0
      AND "amount_credited_cents" >= 0
      AND ("allocated_quantity" + "credited_quantity") >=
          ("held_quantity" + "used_quantity")) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "invoice_sequences" ADD CONSTRAINT "invoice_sequences_range_ck"
    CHECK ("last_value" >= 0 AND "last_value" <= 999999) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
