# OF-RIDER-DELIVERY — Rider Delivery Management backend (additive)

## Objective

Backend APIs for rider delivery management under `/api/v1/rider` (mobile) and
`/api/v1/rider-ops` (warehouse manager). No UI. No ALTER of existing tables —
new tables only. Existing order fulfilment and approval tokens are reused.

## Constraints

- Do not change existing API behaviour or UI.
- Do not add columns to `orders` / `users` / etc.
- Location: HTTP POST + Redis latest + warehouse GET poll (no WebSockets; ~5 riders).
- Warehouse Manager = `WAREHOUSE` (+ `SUPER_ADMIN`). Create/manage riders via rider-ops.

## Status model (on `rider_order_assignments`)

`ASSIGNED` → `OUT_FOR_DELIVERY` → `POD_SUBMITTED` → `POD_REJECTED` |
`POD_APPROVED` (then `progressOrderFulfillment` → order `DELIVERED`) →
`FULFILLMENT_PENDING` → `FULFILLMENT_COMPLETED` (rider verifies `approval_token`
via `fulfillApprovedOrder`).

## Tables

`rider_profiles`, `rider_depots`, `rider_order_assignments`, `rider_pod_images`,
`rider_location_events`. Role seed: `RIDER`. Migration:
`drizzle/20261028120000_add_rider_delivery.sql`.

## Auth

Rider login issues Bearer JWTs backed by `auth_sessions` (same revocation as
web). Ops routes use the existing cookie session.
