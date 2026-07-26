-- Preserve the physical delivery moment separately from order fulfillment.
-- The column is nullable because orders that have not been delivered do not
-- have a delivery date.
ALTER TABLE "orders"
ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone;
--> statement-breakpoint

-- Prefer the exact DELIVERED transition audit timestamp for historical rows.
-- Directly fulfilled and legacy-imported orders use fulfilled_at; updated_at is
-- only the last-resort proxy for delivered rows created before audit tracking.
WITH "delivered_order_dates" AS (
  SELECT
    "order_row"."id",
    COALESCE(
      MIN("audit"."created_at") FILTER (
        WHERE UPPER(COALESCE("audit"."metadata" ->> 'to', '')) = 'DELIVERED'
      ),
      "order_row"."fulfilled_at",
      "order_row"."updated_at"
    ) AS "delivered_at"
  FROM "orders" AS "order_row"
  LEFT JOIN "audit_logs" AS "audit"
    ON "audit"."entity" = 'Order'
    AND "audit"."entity_id" = "order_row"."id"::text
    AND "audit"."action" = 'ORDER_FULFILLMENT_STATUS_UPDATE'
  WHERE UPPER(COALESCE("order_row"."fulfillment_status", 'NOT_STARTED')) = 'DELIVERED'
    AND "order_row"."delivered_at" IS NULL
  GROUP BY "order_row"."id", "order_row"."fulfilled_at", "order_row"."updated_at"
)
UPDATE "orders" AS "order_row"
SET "delivered_at" = "delivery"."delivered_at"
FROM "delivered_order_dates" AS "delivery"
WHERE "order_row"."id" = "delivery"."id"
  AND "order_row"."delivered_at" IS NULL;
