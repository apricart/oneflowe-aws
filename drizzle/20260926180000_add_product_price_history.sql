-- Product price history is an append-only ledger of catalogue price changes.
--
-- Before this migration the Product Price History screen reconstructed a
-- graph from order_items. That made an order look like a price-change event,
-- omitted changes made between orders, and left products with no orders with
-- no history at all. The three authoritative price tiers are:
--
--   global_products.base_price_cents
--   organization_inventory.custom_price_cents
--   group_inventory_prices.custom_price_cents
--
-- Triggers below write the ledger in the same transaction as each tier. This
-- covers every write path (single edits, imports, propagation and operational
-- scripts) without relying on each caller remembering a second insert.
--
-- Production safety:
--   * the schema change is additive;
--   * no current price or order row is modified;
--   * the order backfill is read-only against existing tables;
--   * deterministic source_key values make every backfill insert re-entrant;
--   * only consecutive price transitions are copied, not every order line.

CREATE TABLE IF NOT EXISTS product_price_history (
  id serial PRIMARY KEY,
  global_product_id integer NOT NULL
    REFERENCES global_products(id) ON DELETE CASCADE,
  organization_id integer REFERENCES organizations(id) ON DELETE SET NULL,
  group_id integer REFERENCES groups(id) ON DELETE SET NULL,
  branch_id integer REFERENCES branches(id) ON DELETE SET NULL,
  previous_price_cents bigint,
  price_cents bigint NOT NULL,
  scope varchar(24) NOT NULL,
  change_type varchar(40) NOT NULL,
  source varchar(32) NOT NULL,
  changed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT NOW(),
  -- Non-NULL only for deterministic migration/backfill rows. Live trigger
  -- events deliberately have no key: two real changes must never collapse.
  source_key varchar(160)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS product_price_history_source_key_uq
  ON product_price_history(source_key)
  WHERE source_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_price_history_product_time_idx
  ON product_price_history(global_product_id, changed_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_price_history_stream_time_idx
  ON product_price_history(
    global_product_id,
    organization_id,
    group_id,
    changed_at,
    id
  )
  WHERE price_cents > 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_price_history_org_time_idx
  ON product_price_history(organization_id, changed_at DESC)
  WHERE organization_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_price_history_group_time_idx
  ON product_price_history(group_id, changed_at DESC)
  WHERE group_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_price_history_branch_time_idx
  ON product_price_history(branch_id, changed_at DESC)
  WHERE branch_id IS NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_price_history_prices_valid_ck'
      AND conrelid = 'product_price_history'::regclass
  ) THEN
    ALTER TABLE product_price_history
      ADD CONSTRAINT product_price_history_prices_valid_ck
      CHECK (
        price_cents >= 0
        AND (previous_price_cents IS NULL OR previous_price_cents >= 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_price_history_scope_valid_ck'
      AND conrelid = 'product_price_history'::regclass
  ) THEN
    ALTER TABLE product_price_history
      ADD CONSTRAINT product_price_history_scope_valid_ck
      CHECK (scope IN ('GLOBAL', 'ORGANIZATION', 'GROUP', 'BRANCH'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_price_history_source_valid_ck'
      AND conrelid = 'product_price_history'::regclass
  ) THEN
    ALTER TABLE product_price_history
      ADD CONSTRAINT product_price_history_source_valid_ck
      CHECK (source IN ('CATALOG_CHANGE', 'ORDER_BACKFILL', 'MIGRATION_BASELINE'));
  END IF;
END $$;
--> statement-breakpoint

-- Existing historical evidence. There is no branch-specific price tier, so a
-- branch/order partition would manufacture hundreds of identical "changes".
-- Partition by the effective organization/group price stream and keep only the
-- first known positive price plus subsequent transitions. Cancelled/rejected
-- orders match the exclusions of the former order-derived screen.
WITH ordered_prices AS (
  SELECT
    oi.id AS order_item_id,
    oi.global_product_id,
    o.organization_id,
    b.group_id,
    o.branch_id,
    oi.price_cents,
    COALESCE(o.created_at, oi.created_at, NOW()) AS changed_at,
    LAG(oi.price_cents) OVER (
      PARTITION BY oi.global_product_id, o.organization_id, b.group_id
      ORDER BY COALESCE(o.created_at, oi.created_at), oi.id
    ) AS previous_price_cents
  FROM order_items oi
  INNER JOIN orders o ON o.id = oi.order_id
  INNER JOIN branches b ON b.id = o.branch_id
  WHERE UPPER(o.status) NOT IN ('CANCELLED', 'REJECTED')
    AND oi.price_cents > 0
), price_transitions AS (
  SELECT *
  FROM ordered_prices
  WHERE previous_price_cents IS NULL OR previous_price_cents IS DISTINCT FROM price_cents
)
INSERT INTO product_price_history (
  global_product_id,
  organization_id,
  group_id,
  branch_id,
  previous_price_cents,
  price_cents,
  scope,
  change_type,
  source,
  changed_at,
  source_key
)
SELECT
  global_product_id,
  organization_id,
  group_id,
  branch_id,
  previous_price_cents,
  price_cents,
  'BRANCH',
  'BACKFILLED_ORDER_PRICE',
  'ORDER_BACKFILL',
  changed_at,
  'order-item:' || order_item_id
FROM price_transitions
ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING;
--> statement-breakpoint

-- The exact state at rollout is a truthful starting point for products and
-- tiers that have no order evidence. It is recorded at migration time rather
-- than pretending the current value was known at an older updated_at time
-- (several unrelated writes also advance those timestamps).
INSERT INTO product_price_history (
  global_product_id, previous_price_cents, price_cents, scope, change_type,
  source, changed_by_user_id, changed_at, source_key
)
SELECT
  gp.id, NULL, gp.base_price_cents, 'GLOBAL', 'MIGRATION_BASELINE',
  'MIGRATION_BASELINE', gp.created_by_user_id, NOW(), 'baseline:global:' || gp.id
FROM global_products gp
ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING;
--> statement-breakpoint
INSERT INTO product_price_history (
  global_product_id, organization_id, previous_price_cents, price_cents,
  scope, change_type, source, changed_by_user_id, changed_at, source_key
)
SELECT
  oi.global_product_id, oi.organization_id, NULL,
  COALESCE(oi.custom_price_cents, gp.base_price_cents),
  'ORGANIZATION', 'MIGRATION_BASELINE', 'MIGRATION_BASELINE',
  oi.assigned_by_user_id, NOW(), 'baseline:organization:' || oi.id
FROM organization_inventory oi
INNER JOIN global_products gp ON gp.id = oi.global_product_id
ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING;
--> statement-breakpoint
INSERT INTO product_price_history (
  global_product_id, organization_id, group_id, previous_price_cents,
  price_cents, scope, change_type, source, changed_by_user_id, changed_at,
  source_key
)
SELECT
  oi.global_product_id, gip.organization_id, gip.group_id, NULL,
  gip.custom_price_cents, 'GROUP', 'MIGRATION_BASELINE',
  'MIGRATION_BASELINE', gip.updated_by_user_id, NOW(),
  'baseline:group:' || gip.id
FROM group_inventory_prices gip
INNER JOIN organization_inventory oi ON oi.id = gip.organization_inventory_id
ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION record_global_product_price_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO product_price_history (
      global_product_id, previous_price_cents, price_cents, scope,
      change_type, source, changed_by_user_id, changed_at
    ) VALUES (
      NEW.id, NULL, NEW.base_price_cents, 'GLOBAL', 'PRODUCT_CREATED',
      'CATALOG_CHANGE', NEW.created_by_user_id, COALESCE(NEW.created_at, NOW())
    );
  ELSIF NEW.base_price_cents IS DISTINCT FROM OLD.base_price_cents THEN
    INSERT INTO product_price_history (
      global_product_id, previous_price_cents, price_cents, scope,
      change_type, source, changed_at
    ) VALUES (
      NEW.id, OLD.base_price_cents, NEW.base_price_cents, 'GLOBAL',
      'PRICE_CHANGED', 'CATALOG_CHANGE', NOW()
    );

    -- A Head Office may see its effective organization price but not the
    -- supplier/global tier. Materialize the same change for organizations
    -- that inherit the global value so tenant-scoped history stays complete
    -- without exposing another pricing tier.
    INSERT INTO product_price_history (
      global_product_id, organization_id, previous_price_cents, price_cents,
      scope, change_type, source, changed_at
    )
    SELECT
      NEW.id, oi.organization_id, OLD.base_price_cents, NEW.base_price_cents,
      'ORGANIZATION', 'INHERITED_GLOBAL_CHANGED', 'CATALOG_CHANGE', NOW()
    FROM organization_inventory oi
    WHERE oi.global_product_id = NEW.id
      AND oi.custom_price_cents IS NULL
      AND oi.deleted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS global_product_price_history_trg ON global_products;
--> statement-breakpoint
CREATE TRIGGER global_product_price_history_trg
AFTER INSERT OR UPDATE OF base_price_cents ON global_products
FOR EACH ROW EXECUTE FUNCTION record_global_product_price_history();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION record_organization_price_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  base_price bigint;
  old_effective_price bigint;
  new_effective_price bigint;
BEGIN
  SELECT gp.base_price_cents
  INTO base_price
  FROM global_products gp
  WHERE gp.id = NEW.global_product_id;

  IF TG_OP = 'INSERT' THEN
    -- Assignment establishes the organization's effective price even when it
    -- inherits the global value. This tenant-scoped row is what Head Office
    -- can safely read; the global tier remains Super Admin-only.
    INSERT INTO product_price_history (
      global_product_id, organization_id, previous_price_cents, price_cents,
      scope, change_type, source, changed_by_user_id, changed_at
    ) VALUES (
      NEW.global_product_id, NEW.organization_id, NULL,
      COALESCE(NEW.custom_price_cents, base_price), 'ORGANIZATION',
      CASE WHEN NEW.custom_price_cents IS NULL THEN 'PRICE_INHERITED' ELSE 'OVERRIDE_SET' END,
      'CATALOG_CHANGE', NEW.assigned_by_user_id,
      COALESCE(NEW.assigned_at, NOW())
    );
    RETURN NEW;
  END IF;

  IF NEW.custom_price_cents IS DISTINCT FROM OLD.custom_price_cents THEN
    old_effective_price := COALESCE(OLD.custom_price_cents, base_price);
    new_effective_price := COALESCE(NEW.custom_price_cents, base_price);
    IF old_effective_price IS DISTINCT FROM new_effective_price THEN
      INSERT INTO product_price_history (
        global_product_id, organization_id, previous_price_cents, price_cents,
        scope, change_type, source, changed_at
      ) VALUES (
        NEW.global_product_id, NEW.organization_id, old_effective_price,
        new_effective_price, 'ORGANIZATION',
        CASE WHEN NEW.custom_price_cents IS NULL THEN 'OVERRIDE_REMOVED' ELSE 'PRICE_CHANGED' END,
        'CATALOG_CHANGE', NOW()
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS organization_price_history_trg ON organization_inventory;
--> statement-breakpoint
CREATE TRIGGER organization_price_history_trg
AFTER INSERT OR UPDATE OF custom_price_cents ON organization_inventory
FOR EACH ROW EXECUTE FUNCTION record_organization_price_history();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION record_group_price_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  item_id integer;
  product_id integer;
  tenant_id integer;
  group_row_id integer;
  actor_id uuid;
  override_price bigint;
  inherited_price bigint;
  old_effective_price bigint;
  new_effective_price bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    item_id := OLD.organization_inventory_id;
    tenant_id := OLD.organization_id;
    group_row_id := OLD.group_id;
    actor_id := OLD.updated_by_user_id;
    override_price := OLD.custom_price_cents;
  ELSE
    item_id := NEW.organization_inventory_id;
    tenant_id := NEW.organization_id;
    group_row_id := NEW.group_id;
    actor_id := NEW.updated_by_user_id;
    override_price := NEW.custom_price_cents;
  END IF;

  -- When the parent group itself is being hard-deleted, PostgreSQL removes
  -- the parent before the cascading child DELETE trigger runs. That is
  -- lifecycle cleanup, not an override being removed from a live group, and a
  -- history row cannot retain a foreign key to the already-gone parent.
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM groups g WHERE g.id = group_row_id
  ) THEN
    RETURN NULL;
  END IF;

  SELECT oi.global_product_id, COALESCE(oi.custom_price_cents, gp.base_price_cents)
  INTO product_id, inherited_price
  FROM organization_inventory oi
  INNER JOIN global_products gp ON gp.id = oi.global_product_id
  WHERE oi.id = item_id;

  -- Cascading hard deletion of an inventory/product row has no surviving
  -- catalogue context and is lifecycle cleanup, not a price change.
  IF product_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    old_effective_price := inherited_price;
    new_effective_price := override_price;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.custom_price_cents IS NOT DISTINCT FROM OLD.custom_price_cents THEN
      RETURN NEW;
    END IF;
    old_effective_price := OLD.custom_price_cents;
    new_effective_price := NEW.custom_price_cents;
  ELSE
    old_effective_price := override_price;
    new_effective_price := inherited_price;
  END IF;

  IF old_effective_price IS DISTINCT FROM new_effective_price THEN
    INSERT INTO product_price_history (
      global_product_id, organization_id, group_id, previous_price_cents,
      price_cents, scope, change_type, source, changed_by_user_id, changed_at
    ) VALUES (
      product_id, tenant_id, group_row_id, old_effective_price,
      new_effective_price, 'GROUP',
      CASE
        WHEN TG_OP = 'DELETE' THEN 'OVERRIDE_REMOVED'
        WHEN TG_OP = 'INSERT' THEN 'OVERRIDE_SET'
        ELSE 'PRICE_CHANGED'
      END,
      'CATALOG_CHANGE', actor_id, NOW()
    );
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS group_price_history_trg ON group_inventory_prices;
--> statement-breakpoint
CREATE TRIGGER group_price_history_trg
AFTER INSERT OR UPDATE OF custom_price_cents OR DELETE ON group_inventory_prices
FOR EACH ROW EXECUTE FUNCTION record_group_price_history();
--> statement-breakpoint

ALTER TABLE product_price_history ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE product_price_history FROM anon;
    REVOKE ALL ON SEQUENCE product_price_history_id_seq FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE product_price_history FROM authenticated;
    REVOKE ALL ON SEQUENCE product_price_history_id_seq FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneflowe_runtime') THEN
    GRANT SELECT, INSERT ON TABLE product_price_history TO oneflowe_runtime;
    GRANT USAGE, SELECT ON SEQUENCE product_price_history_id_seq TO oneflowe_runtime;
  END IF;
END $$;
