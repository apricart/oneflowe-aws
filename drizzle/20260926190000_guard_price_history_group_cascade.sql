-- A hard group deletion cascades into group_inventory_prices after the parent
-- row has gone. That cleanup is not a live override removal and cannot write a
-- history row that still references the deleted group. Keep the guard in a
-- follow-up migration as well as the original definition so databases where
-- the first migration was already exercised converge safely.
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
