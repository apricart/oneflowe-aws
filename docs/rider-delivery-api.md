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
| GET | `/api/v1/rider/route` | depot + today's stops + OSRM `geometry`. Optional `?latitude=&longitude=` = **live** nav from GPS → remaining stops (drops travelled path) |
| POST | `/api/v1/rider/location` | Redis upsert (~1/3s) |
| GET/PATCH | `/api/v1/rider/notifications` | overdue / rider notices |

Envelope: `{ success, data, error }`.

## Warehouse ops (cookie session; `SUPER_ADMIN` \| `WAREHOUSE`)

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/v1/rider-ops/riders` | list / create rider |
| GET/PATCH | `/api/v1/rider-ops/riders/:id` | detail / update |
| GET/PUT | `/api/v1/rider-ops/depot` | warehouse start lat/lng |
| GET/POST | `/api/v1/rider-ops/assignments` | list / multi-assign (order must be APPROVED + OUT_FOR_DELIVERY) |
| PATCH | `/api/v1/rider-ops/assignments/sequence` | reorder |
| GET | `/api/v1/rider-ops/assignments/:id` | detail + POD images (`proofImages[].fileUrl`) |
| GET | `/api/v1/rider-ops/assignments/:id/pod/:imageId/file` | stream one POD image (warehouse-scoped) |
| POST | `/api/v1/rider-ops/assignments/:id/pod/approve` | Mark delivered → order `DELIVERED`, assignment `FULFILLMENT_PENDING` |
| POST | `/api/v1/rider-ops/assignments/:id/pod/reject` | `{ reason }` → `POD_REJECTED` (rider re-uploads) |
| GET | `/api/v1/rider-ops/riders/locations` | live GPS + today's stops (warehouse-scoped); `?riderId=` for Track |
| GET | `/api/v1/rider-ops/assignments?day=today` | Karachi today + overdue carry-overs |

### Delivery → fulfilment pipeline

1. **Rider** uploads photos only: `POST /api/v1/rider/orders/:id/pod` → assignment `POD_SUBMITTED`.
2. **Warehouse** opens **POD review** (Riders section), views images, then either:
   - **Mark delivered** (`…/pod/approve`) → order fulfilment `DELIVERED`, assignment `FULFILLMENT_PENDING`, or
   - **Reject** (`…/pod/reject`) → `POD_REJECTED`; rider submits a new POD.
3. **Rider** enters the customer 6-digit fulfilment token: `POST /api/v1/rider/orders/:id/fulfillment-token` → validates `orders.approval_token`, runs `fulfillApprovedOrder` → order `FULFILLED`, assignment `FULFILLMENT_COMPLETED`.

The token API refuses until warehouse has approved the POD (order must be `DELIVERED`). Reject does not deliver the order.

POD approve notifies warehouse via `WAREHOUSE_RIDER_POD_SUBMITTED`. Same-day misses notify warehouse (`WAREHOUSE_RIDER_DELIVERY_OVERDUE`) and rider (`RIDER_DELIVERY_OVERDUE`).

**Route contract for mobile MapScreen:**
1. On open: `GET /rider/route` → draw `geometry` (`geometryMode: "planned"` = warehouse → remaining).
2. While on duty / moving: on each location ping (or every few seconds), call  
   `GET /rider/route?latitude={lat}&longitude={lng}` → **replace** the polyline with the new `geometry` (`geometryMode: "live"`). Do not keep the old path — travelled segments are intentionally omitted.
3. Markers: green when `delivered`, orange when `overdue`. Head toward `nextStop`. Never draw a return-to-depot leg.

## Local APK against this Mac

`npm run dev` binds `0.0.0.0` so a phone on the same Wi‑Fi can reach the API.

- APK base URL: `http://192.168.1.43:3000` (this Mac’s LAN IP)
- Login: `POST /api/v1/rider/auth/login` body `{ "identifier", "password" }`
- Android debug builds must allow cleartext HTTP to that host

Machine-only (no LAN): `npm run dev:local`.

## Smoke

```bash
./scripts/smoke-rider-api.sh
```
Requires `BASE_URL`, `RIDER_IDENTIFIER`, `RIDER_PASSWORD`.
