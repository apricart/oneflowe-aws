# Warehouse rider assign + route planner UI

## Objective
Warehouse can assign OUT_FOR_DELIVERY orders to riders from the orders queue, manage riders from a sidebar section, and plan today's stop sequence on a split list+map screen. Rider mobile shows the same sequence.

## Acceptance
1. Orders queue: Assign action on eligible rows → dialog → `POST /api/v1/rider-ops/assignments`
2. Sidebar **Riders** (`#riders`): list from `GET /rider-ops/riders`, open route planner
3. Route planner: left = today's assignments (reorder), right = map pins numbered by sequence → `PATCH /rider-ops/assignments/sequence`
4. Rider app: orders/map sorted by `deliverySequence`; markers show stop numbers; optional `GET /rider/route` for depot

## Architecture
- UI only on existing rider-ops APIs (no schema change)
- Warehouse hash sections stay in `WarehouseWorkspace` (no new proxy areas)
- Map: Leaflet (OSM) for warehouse planner; Android already has Google Maps

## Steps
1. Assign dialog + wire into warehouse orders
2. Riders list + route planner components
3. Wire sidebar sections
4. Rider Android: sequence field + sort + numbered markers
