-- Rider city ↔ warehouse depot: one warehouse start pin per city; riders belong to that warehouse.
ALTER TABLE "rider_profiles"
  ADD COLUMN IF NOT EXISTS "city_key" varchar(120),
  ADD COLUMN IF NOT EXISTS "city_label" varchar(120),
  ADD COLUMN IF NOT EXISTS "warehouse_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "rider_profiles_warehouse_user_idx"
  ON "rider_profiles" ("warehouse_user_id");

CREATE INDEX IF NOT EXISTS "rider_profiles_city_key_idx"
  ON "rider_profiles" ("city_key");

ALTER TABLE "rider_depots"
  ADD COLUMN IF NOT EXISTS "city_key" varchar(120),
  ADD COLUMN IF NOT EXISTS "city_label" varchar(120);

-- At most one warehouse depot claims a city.
CREATE UNIQUE INDEX IF NOT EXISTS "rider_depots_city_key_uq"
  ON "rider_depots" ("city_key")
  WHERE "city_key" IS NOT NULL;
