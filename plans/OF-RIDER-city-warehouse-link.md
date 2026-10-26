# Rider city → warehouse link + Create Rider UI

## Objective
Warehouse creates riders with a required **city**. Each city has at most one warehouse depot (start point). Riders belong to that warehouse. Plan route starts from the city warehouse pin. Karachi depot: `24.845556, 67.098833` (24°50'44.0"N 67°05'55.8"E).

## Acceptance
1. Create Rider screen on Warehouse → Riders (city required from Pakistan list)
2. Rider profile stores `city_key`, `city_label`, `warehouse_user_id`
3. Depot stores `city_key` (unique) — one warehouse per city
4. Creating a Karachi rider ensures Karachi depot at the given coords for the creating warehouse
5. Warehouse list/assign/plan only sees **its** riders; route start = city depot
6. Web rider-ops UI remains under the warehouse workspace (role already gated)

## Data
- Migration: `rider_profiles.city_key`, `city_label`, `warehouse_user_id`; `rider_depots.city_key` + unique index
- Rollback: drop columns / index

## Steps
1. Migration + schema + city depot constants — done (`20261029120000`)
2. Create/list riders scoped; ensure depot on create — done (POST warehouse-only)
3. Depot GET by city / rider; route planner uses city depot — done (`?riderId=`)
4. Create Rider dialog UI — done (`components/warehouse/create-rider-dialog.tsx`)
