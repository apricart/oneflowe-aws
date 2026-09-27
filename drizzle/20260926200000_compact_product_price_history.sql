-- Compact historical order evidence into actual consumer-price transitions.
--
-- The first ledger migration originally partitioned legacy order prices by
-- branch. Branches do not have their own price tier, so the first order for
-- every branch produced another row even when the organization/group price was
-- continuously unchanged. This repair groups records by the real consumer
-- price stream: product + organization + optional group.
--
-- Only derived migration rows are removed. Live CATALOG_CHANGE events remain
-- append-only. Zero prices stay available as audit evidence but are excluded
-- from transition calculations and from the API.

WITH positive_timeline AS (
  SELECT
    id,
    price_cents,
    source,
    LAG(price_cents) OVER (
      PARTITION BY
        global_product_id,
        COALESCE(organization_id, -1),
        COALESCE(group_id, -1)
      ORDER BY changed_at, id
    ) AS previous_timeline_price_cents
  FROM product_price_history
  WHERE price_cents > 0
), redundant_derived_rows AS (
  SELECT id
  FROM positive_timeline
  WHERE source IN ('ORDER_BACKFILL', 'MIGRATION_BASELINE')
    AND previous_timeline_price_cents IS NOT NULL
    AND previous_timeline_price_cents = price_cents
)
DELETE FROM product_price_history history
USING redundant_derived_rows redundant
WHERE history.id = redundant.id;
--> statement-breakpoint

-- Recalculate the retained derived rows' previous price using the same stream
-- definition. This replaces old branch-local previous values with the actual
-- preceding organization/group consumer price.
WITH positive_timeline AS (
  SELECT
    id,
    source,
    LAG(price_cents) OVER (
      PARTITION BY
        global_product_id,
        COALESCE(organization_id, -1),
        COALESCE(group_id, -1)
      ORDER BY changed_at, id
    ) AS previous_timeline_price_cents
  FROM product_price_history
  WHERE price_cents > 0
)
UPDATE product_price_history history
SET previous_price_cents = timeline.previous_timeline_price_cents
FROM positive_timeline timeline
WHERE history.id = timeline.id
  AND timeline.source IN ('ORDER_BACKFILL', 'MIGRATION_BASELINE')
  AND history.previous_price_cents IS DISTINCT FROM timeline.previous_timeline_price_cents;
--> statement-breakpoint

-- Supports the API's partitioned transition scan without indexing invalid
-- zero-price evidence that the feature deliberately ignores.
CREATE INDEX IF NOT EXISTS product_price_history_stream_time_idx
  ON product_price_history(
    global_product_id,
    organization_id,
    group_id,
    changed_at,
    id
  )
  WHERE price_cents > 0;
