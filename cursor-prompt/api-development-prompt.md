# Agent Prompt: Rider App API (`/api/v1`) for Existing Next.js Web App

> **How to use:** Paste this entire document (or from “MISSION” downward) into your Next.js agent. It is the contract for implementing rider APIs inside the **same Next.js deployment** that already serves the warehouse/admin web app.

---

## MISSION

You are a senior Next.js / Node backend engineer. Implement a **versioned Rider Mobile API** under:

```text
/api/v1/rider/...
```

inside the **existing Apricart Next.js web project** (admin/warehouse panel). Goals:

1. One deployment serves **admin web + rider Android app**.
2. Load is tiny (~**max 10 concurrent riders**) — no microservices, no separate BFF required.
3. Contract must match the **Android rider app UI prototype** so the mobile team can swap mock repositories for real HTTP with minimal UI change.
4. Prefer reusing existing DB models / auth / order tables if they already exist; **extend** them rather than inventing parallel schemas. If something does not exist yet, create what is needed and document assumptions.

**Out of scope for this pass:** WebSockets / background location streaming at scale. Implement **HTTP polling / periodic POST** for location first. Leave clear `TODO` comments for future socket / SSE if useful.

---

## CONTEXT — How the rider app works

Riders are **employees**. Warehouse managers assign orders from the **web admin**. The Android app is rider-facing only.

### Mobile screens that consume APIs

| Screen | Needs |
|--------|--------|
| Splash | Optional session restore (`GET /me` with stored JWT) |
| Login | `POST /auth/login` |
| Home | Today’s orders, previous orders, stats, on-duty toggle, location permission (client-only) |
| Order Detail | Order by id; submit POD (photos + acknowledgment token) |
| Map | Today’s orders (markers); optional last-known rider location |
| Profile | Rider profile; logout (client-side token clear + optional revoke) |

### Order status machine (must match mobile)

```text
assigned → picked_up → in_transit → awaiting_admin_verification → delivered
                                                      ↘ cancelled (edge)
```

- Rider submits proof → status becomes **`awaiting_admin_verification`** (not `delivered`).
- **Admin** (web panel) verifies photos/token and marks **`delivered`**.
- Mobile also shows: `assigned`, `picked_up`, `in_transit`, `delivered`, `awaiting_admin_verification`, `cancelled`.

### Payment types

`cod` | `prepaid`

---

## ARCHITECTURE RULES

1. **Base path:** `/api/v1/rider`
2. **Format:** JSON, `Content-Type: application/json` (except multipart upload).
3. **Auth:** Bearer JWT (`Authorization: Bearer <accessToken>`).
4. **Timestamps:** ISO-8601 UTC strings in JSON (e. andg. `"2026-10-21T10:15:00.000Z"`). Mobile will parse to millis.
5. **Money:** `amount` as number (PKR). Currency implied PKR unless you already have multi-currency.
6. **IDs:** Stable string IDs (`ORD-78421`, `RDR-1024`) or UUIDs — be consistent with existing DB. Prefer human-readable order codes if admin already uses them.
7. **Errors:** Uniform envelope (below). Never leak stack traces in production.
8. **CORS:** Allow mobile origins if needed; native apps often don’t need CORS, but keep API usable from Postman.
9. **Rate limits:** Light — e.g. location POST max ~1 req / 3–5s per rider; login lockout after N failures.
10. **Do not break** existing admin routes. Rider APIs are additive under `/api/v1/rider`.

---

## STANDARD RESPONSE ENVELOPES

### Success

```json
{
  "success": true,
  "data": {},
  "meta": {
    "requestId": "optional-uuid",
    "timestamp": "2026-10-21T10:15:00.000Z"
  }
}
```

List endpoints may use:

```json
{
  "success": true,
  "data": {
    "items": [],
    "stats": {}
  }
}
```

### Error

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Human readable message",
    "details": null
  }
}
```

### Suggested HTTP status + codes

| HTTP | code | When |
|------|------|------|
| 400 | `VALIDATION_ERROR` | Bad body / query |
| 401 | `UNAUTHORIZED` | Missing/invalid token |
| 403 | `FORBIDDEN` | Rider not assigned to order / off-duty restricted |
| 404 | `NOT_FOUND` | Order/rider missing |
| 409 | `CONFLICT` | Invalid status transition |
| 413 | `PAYLOAD_TOO_LARGE` | >3 images or file too big |
| 429 | `RATE_LIMITED` | Too many location/login calls |
| 500 | `INTERNAL_ERROR` | Unexpected |

---

## SHARED TYPES (JSON schema for contracts)

Use these shapes everywhere so Android `fromJson` mapping stays trivial.

### `Rider`

```json
{
  "id": "RDR-1024",
  "name": "Ahmed Khan",
  "phone": "+92 300 9876543",
  "vehicleNumber": "LEC-4521",
  "isOnDuty": true,
  "avatarUrl": null
}
```

### `LatLng`

```json
{
  "latitude": 24.8607,
  "longitude": 67.0011
}
```

### `AddressInfo`

```json
{
  "name": "Apricart Warehouse – Korangi",
  "address": "Plot 42, Sector 7-A, Korangi Industrial Area, Karachi",
  "phone": "+92 21 35123456",
  "area": "Korangi",
  "location": { "latitude": 24.8372, "longitude": 67.1118 }
}
```

### `OrderItem`

```json
{
  "name": "Basmati Rice 5kg",
  "quantity": 1
}
```

### `Order` (canonical)

```json
{
  "id": "ORD-78421",
  "customerName": "Sara Ali",
  "status": "assigned",
  "assignedAt": "2026-10-21T09:15:00.000Z",
  "deliveredAt": null,
  "timeSlot": "10:00 AM – 12:00 PM",
  "paymentType": "cod",
  "amount": 2450,
  "items": [
    { "name": "Basmati Rice 5kg", "quantity": 1 }
  ],
  "pickup": { "...": "AddressInfo" },
  "delivery": { "...": "AddressInfo" },
  "acknowledgmentToken": null,
  "proofImageUrls": []
}
```

**Field notes for Android mapping:**

| API field | Mobile usage |
|-----------|----------------|
| `status` | snake_case enum string |
| `assignedAt` / `deliveredAt` | ISO → millis |
| `paymentType` | `cod` \| `prepaid` |
| `proofImageUrls` | HTTPS URLs after upload (mobile currently uses local URIs in mock) |
| `acknowledgmentToken` | 6-digit string when submitted / for read-only history |

---

## AUTH

### 1) `POST /api/v1/rider/auth/login`

**Auth:** none  
**Purpose:** Rider login with Rider ID **or** phone + password.

**Request**

```json
{
  "identifier": "RDR-1024",
  "password": "secret"
}
```

`identifier` = rider code OR phone (normalize spaces/`+`).

**Response `200`**

```json
{
  "success": true,
  "data": {
    "accessToken": "<jwt>",
    "refreshToken": "<jwt-or-opaque>",
    "expiresIn": 86400,
    "rider": {
      "id": "RDR-1024",
      "name": "Ahmed Khan",
      "phone": "+92 300 9876543",
      "vehicleNumber": "LEC-4521",
      "isOnDuty": true,
      "avatarUrl": null
    }
  }
}
```

**Errors:** `401 INVALID_CREDENTIALS`, `403 RIDER_DISABLED`

**JWT claims (suggested):** `sub` = riderId, `role` = `rider`, `iat`, `exp`

---

### 2) `POST /api/v1/rider/auth/refresh` (optional but recommended)

**Request**

```json
{ "refreshToken": "..." }
```

**Response:** new `accessToken` (+ rotated refresh if you use rotation)

---

### 3) `POST /api/v1/rider/auth/logout`

**Auth:** Bearer  
**Request:** `{}` or `{ "refreshToken": "..." }`  
**Response:** `{ "success": true, "data": { "loggedOut": true } }`  
Invalidate refresh token server-side if stored.

---

### 4) `GET /api/v1/rider/auth/me`

**Auth:** Bearer  
**Purpose:** Splash / cold start session restore.

**Response `200`**

```json
{
  "success": true,
  "data": {
    "rider": { "...": "Rider" }
  }
}
```

---

## RIDER PROFILE / DUTY

### 5) `GET /api/v1/rider/profile`

Same as `/auth/me` or richer profile. Keep one source of truth.

**Response** includes: id, name, phone, vehicleNumber, isOnDuty, avatarUrl, supportPhone (optional from config).

---

### 6) `PATCH /api/v1/rider/duty`

**Auth:** Bearer  
**Purpose:** On-duty / off-duty toggle on Home header.

**Request**

```json
{ "isOnDuty": true }
```

**Response**

```json
{
  "success": true,
  "data": {
    "rider": { "id": "RDR-1024", "isOnDuty": true, "...": "..." }
  }
}
```

**Business rules:**
- When `isOnDuty: false`, admin may still see last location but stop expecting live updates.
- Optionally reject new assignment acceptance when off-duty (admin concern).

---

## ORDERS

All order endpoints: **Auth Bearer**. Only return orders **assigned to the authenticated rider**.

### 7) `GET /api/v1/rider/orders/today`

**Purpose:** Home “Today’s Orders” tab + Map markers + Home stats.

**Query (optional):** none required. Server uses rider’s warehouse timezone (document it; default `Asia/Karachi`).

**Response `200`**

```json
{
  "success": true,
  "data": {
    "items": [ { "...": "Order" } ],
    "stats": {
      "total": 6,
      "delivered": 1,
      "pending": 5
    }
  }
}
```

**Stats rules (match mobile prototype):**
- `delivered` count = status in (`delivered`, `awaiting_admin_verification`)
- `pending` = `total - delivered`
- Sort: `assignedAt` ascending

Include **all of today’s assigned orders** regardless of status (including already delivered today).

---

### 8) `GET /api/v1/rider/orders/previous`

**Purpose:** Previous Orders tab (history), grouped by date on client.

**Query**

| param | default | notes |
|-------|---------|--------|
| `days` | `7` | lookback window |
| `limit` | `50` | max items |
| `cursor` | — | optional pagination |

**Response**

```json
{
  "success": true,
  "data": {
    "items": [ { "...": "Order", "status": "delivered" } ]
  }
}
```

**Rules:**
- Only `status === "delivered"`
- `assignedAt` (or delivery day) **before today** in rider timezone
- Sort: newest first
- Include `proofImageUrls` + `acknowledgmentToken` for read-only detail

---

### 9) `GET /api/v1/rider/orders/:orderId`

**Purpose:** Order Detail screen.

**Response:** `{ "success": true, "data": { "order": { "...": "Order" } } }`

**Errors:** `404`, `403` if not assigned to this rider.

---

### 10) `PATCH /api/v1/rider/orders/:orderId/status` (optional but useful)

**Purpose:** Let rider advance workflow before POD (if admin does not auto-advance).

**Request**

```json
{
  "status": "picked_up"
}
```

Allowed rider transitions (enforce strictly):

```text
assigned → picked_up
picked_up → in_transit
in_transit → (only via POD submit → awaiting_admin_verification)
```

Rider must **not** set `delivered` directly.

**Response:** updated `Order`

**Errors:** `409 CONFLICT` on illegal transition

---

## PROOF OF DELIVERY (POD)

Mobile requires:
- ≥1 and ≤3 images
- acknowledgment token: exactly **6 digits**
- on success: status → `awaiting_admin_verification`

Prefer **two-step** upload (more reliable on mobile):

### 11a) `POST /api/v1/rider/orders/:orderId/proof/images`

**Auth:** Bearer  
**Content-Type:** `multipart/form-data`

**Fields:**
- `files`: 1–3 images (`image/jpeg`, `image/png`, `image/webp`)
- max size per file: e.g. **5 MB**

**Response**

```json
{
  "success": true,
  "data": {
    "urls": [
      "https://cdn.example.com/pod/ORD-78421/1.jpg",
      "https://cdn.example.com/pod/ORD-78421/2.jpg"
    ]
  }
}
```

Store in S3/R2/Cloudinary/local `public/uploads` — reuse whatever the Next.js app already uses for images.

---

### 11b) `POST /api/v1/rider/orders/:orderId/proof`

**Auth:** Bearer  
**JSON body**

```json
{
  "acknowledgmentToken": "482901",
  "imageUrls": [
    "https://cdn.example.com/pod/ORD-78421/1.jpg"
  ],
  "notes": null
}
```

**Validation:**
- `acknowledgmentToken`: `/^\d{6}$/`
- `imageUrls`: length 1–3, must be URLs owned by this order/rider upload (prevent arbitrary URL injection)
- Order must be assigned to rider
- Current status must be `assigned` | `picked_up` | `in_transit` (not already delivered)

**Server actions:**
1. Save token + image URLs on order
2. Set `status = "awaiting_admin_verification"`
3. Set `deliveredAt` = now (or `proofSubmittedAt` if you prefer a separate field — if separate, still return something mobile can show; simplest: set `deliveredAt` on proof submit as “rider completed delivery”, admin later confirms)
4. Notify admin (optional: email / in-app flag on existing admin dashboard)

**Response `200`**

```json
{
  "success": true,
  "data": {
    "order": {
      "id": "ORD-78421",
      "status": "awaiting_admin_verification",
      "acknowledgmentToken": "482901",
      "proofImageUrls": ["https://..."],
      "deliveredAt": "2026-10-21T12:05:00.000Z"
    }
  }
}
```

### Alternative: single multipart endpoint

`POST /api/v1/rider/orders/:orderId/proof` with `files` + `acknowledgmentToken` field — also acceptable; document chosen approach in README.

---

## LOCATION (HTTP first)

Mobile streams location every ~3s locally. For 10 riders, periodic POST is enough.

### 12) `POST /api/v1/rider/location`

**Auth:** Bearer  
**Request**

```json
{
  "latitude": 24.8607,
  "longitude": 67.0011,
  "accuracyMeters": 12.5,
  "heading": 90.0,
  "speedMps": 4.2,
  "recordedAt": "2026-10-21T10:15:00.000Z",
  "isOnDuty": true
}
```

**Response**

```json
{
  "success": true,
  "data": {
    "accepted": true
  }
}
```

**Server:**
- Upsert `RiderLocation` (riderId, lat, lng, accuracy, recordedAt, updatedAt)
- Ignore stale points if `recordedAt` older than last stored
- Rate-limit ~1 req / 3s
- Expose last location to **admin web** (existing map/tracking UI if any)

### 13) `GET /api/v1/rider/location/me` (optional)

Returns last known point for debugging.

---

## ADMIN-SIDE HOOKS (minimal, same Next.js app)

Not called by the rider app, but required for end-to-end product. Implement or stub:

| Action | Suggested route | Effect |
|--------|-----------------|--------|
| Assign order to rider | existing admin API or `POST /api/v1/admin/orders/:id/assign` | sets `riderId`, status `assigned` |
| Verify POD → Delivered | `POST /api/v1/admin/orders/:id/verify-delivery` | status `delivered` |
| Reject POD | `POST /api/v1/admin/orders/:id/reject-proof` | back to `in_transit` + reason |

Document these so the admin UI agent can wire buttons.

---

## FILE / FOLDER SUGGESTION (Next.js App Router)

```text
app/api/v1/rider/
  auth/
    login/route.ts
    logout/route.ts
    refresh/route.ts
    me/route.ts
  profile/route.ts
  duty/route.ts
  orders/
    today/route.ts
    previous/route.ts
    [orderId]/route.ts
    [orderId]/status/route.ts
    [orderId]/proof/route.ts
    [orderId]/proof/images/route.ts
  location/route.ts
lib/rider/
  auth.ts          # jwt sign/verify
  errors.ts        # envelope helpers
  orders.ts        # queries + status transitions
  upload.ts
  rateLimit.ts
```

If the project still uses **Pages Router**, mirror under `pages/api/v1/rider/...`.

---

## SECURITY CHECKLIST

- [ ] Passwords hashed (bcrypt/argon2); never return password hashes
- [ ] Rider can only read/update **own** orders
- [ ] POD image URLs validated against your storage prefix / upload session
- [ ] JWT secret in env (`RIDER_JWT_SECRET` or shared `JWT_SECRET`)
- [ ] File type sniffing (not only extension)
- [ ] HTTPS only in production
- [ ] Do not log tokens or full POD images

---

## ENV VARS TO DOCUMENT

```env
RIDER_JWT_SECRET=
RIDER_JWT_EXPIRES_IN=1d
RIDER_UPLOAD_DIR=   # or S3 creds
RIDER_MAX_UPLOAD_MB=5
RIDER_TIMEZONE=Asia/Karachi
```

---

## ACCEPTANCE CRITERIA (agent must verify)

1. `POST /auth/login` returns JWT + rider matching mobile `Rider` shape.
2. `GET /orders/today` returns only that rider’s today orders + stats formula above.
3. `GET /orders/previous` returns delivered history only.
4. `GET /orders/:id` 403 for another rider’s order.
5. POD submit with 1–3 images + 6-digit token → status `awaiting_admin_verification`.
6. Illegal status jump returns `409`.
7. `PATCH /duty` toggles `isOnDuty`.
8. `POST /location` upserts last location for admin visibility.
9. OpenAPI or a short `docs/rider-api.md` generated in the Next.js repo listing every route with example request/response.
10. Postman/Thunder collection OR a `scripts/smoke-rider-api.sh` that hits login → today → detail → (mock) proof.

---

## IMPLEMENTATION ORDER

1. Auth login + me + JWT middleware helper  
2. Orders today / previous / by id  
3. Duty toggle  
4. POD upload + submit  
5. Location POST  
6. Admin verify-delivery hook  
7. Docs + smoke test  

---

## MAPPING HINT FOR ANDROID TEAM (do not implement Android here)

Replace mocks in:

- `AuthRepository` ← login / me / duty / logout  
- `OrdersRepository` ← today / previous / byId / submitProof  
- `LocationRepository` ← POST location on interval when on-duty  

Base URL example: `https://<same-nextjs-domain>/api/v1/rider`

---

## IMPORTANT PRODUCT NOTES FOR THE AGENT

- Same Next.js deployment is intentional (≤10 riders). Keep code simple and reliable over clever.
- Reuse existing Order / User / Rider tables if present; add columns: `riderId`, `acknowledgmentToken`, `proofImageUrls[]`, `status` enum including `awaiting_admin_verification`, `isOnDuty`, `lastLat`, `lastLng`, `lastLocationAt`.
- If current order statuses differ, provide a **mapping layer** and document it — do not silently rename admin statuses without migration notes.
- Prefer **idempotent** POD submit: repeating same token+urls should not duplicate rows; return current order if already `awaiting_admin_verification`.

---

## DELIVERABLES

1. Working route handlers under `/api/v1/rider/*`
2. DB migrations / schema changes
3. `docs/rider-api.md` with every endpoint’s request/response
4. Smoke test script or Postman collection
5. Short note on how admin verifies POD

Begin by inspecting the existing Next.js codebase (auth, Prisma/Mongoose/SQL, order models). Then implement against **this contract**, adapting field names only where the existing schema forces it — and document any deviation explicitly in `docs/rider-api.md`.
```
