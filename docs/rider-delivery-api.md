# Rider Delivery API

Additive backend for rider mobile + warehouse ops. See `plans/OF-RIDER-DELIVERY-backend.md`.

**Apply migration** `20261028120000_add_rider_delivery` before use.

## Deviations from the Android prompt

| Topic | Choice |
|---|---|
| Auth | Bearer JWT signed with `NEXTAUTH_SECRET`, sessions in `auth_sessions` (not a separate `RIDER_JWT_SECRET`) |
| Statuses | Live on `rider_order_assignments.status`, not `orders.fulfillment_status`. Mobile mapping in `mapAssignmentStatusToMobile` |
| Order id | TID string in rider JSON; numeric id internal |
| Location | HTTP POST + Redis latest + warehouse GET poll (no WebSockets; ~5 riders) |
| Existing tables | Not altered — assignment/POD/coords in new tables only |

## Rider mobile (`Authorization: Bearer <accessToken>`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/rider/auth/login` | `{ identifier, password }` → tokens + rider |
| POST | `/api/v1/rider/auth/refresh` | `{ refreshToken }` |
| POST | `/api/v1/rider/auth/logout` | revoke session |
| GET | `/api/v1/rider/auth/me` | splash |
| GET | `/api/v1/rider/profile` | profile |
| PATCH | `/api/v1/rider/duty` | `{ isOnDuty }` |
| GET | `/api/v1/rider/orders` | assigned orders |
| GET | `/api/v1/rider/orders/:orderId` | detail (TID or numeric id) |
| PATCH | `/api/v1/rider/orders/:orderId/status` | `{ status: picked_up\|in_transit }` → OUT_FOR_DELIVERY |
| POST | `/api/v1/rider/orders/:orderId/arrive` | `{ latitude, longitude }` |
| POST | `/api/v1/rider/orders/:orderId/pod` | multipart `files` (1–3) |
| POST | `/api/v1/rider/orders/:orderId/fulfillment-token` | `{ token }` after POD approved |
| GET | `/api/v1/rider/route` | depot + sequenced stops |
| POST | `/api/v1/rider/location` | Redis upsert (~1/3s) |

Envelope: `{ success, data, error }`.

## Warehouse ops (cookie session; `SUPER_ADMIN` \| `WAREHOUSE`)

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/v1/rider-ops/riders` | list / create rider |
| GET/PATCH | `/api/v1/rider-ops/riders/:id` | detail / update |
| GET/PUT | `/api/v1/rider-ops/depot` | warehouse start lat/lng |
| GET/POST | `/api/v1/rider-ops/assignments` | list / multi-assign (order must be APPROVED + OUT_FOR_DELIVERY) |
| PATCH | `/api/v1/rider-ops/assignments/sequence` | reorder |
| GET | `/api/v1/rider-ops/assignments/:id` | detail + POD images |
| POST | `/api/v1/rider-ops/assignments/:id/pod/approve` | → DELIVERED via `progressOrderFulfillment` |
| POST | `/api/v1/rider-ops/assignments/:id/pod/reject` | `{ reason }` |
| GET | `/api/v1/rider-ops/riders/locations` | latest Redis points for map poll |

POD approve notifies warehouse via `WAREHOUSE_RIDER_POD_SUBMITTED` on the existing notifications table (warehouse bell).

## Smoke

```bash
./scripts/smoke-rider-api.sh
```
Requires `BASE_URL`, `RIDER_IDENTIFIER`, `RIDER_PASSWORD`.
