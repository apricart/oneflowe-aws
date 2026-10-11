# OF-DELIVERY — Management delivery dashboard and the Apricart Executive role

Source: the management delivery dashboard plan (SLA, health, KPI cards,
attention table, city/region/branch views, pipeline, timeline drill-down).
This file is how it is built in OneFlowe; where the source plan assumed
something the system does not have, the decision is recorded here.

## Objective

Apricart's CEO and directors open one read-only screen and see, across every
client, which approved orders are on track, due soon or overdue, how late, where
they are stuck, and how each city, region and branch is performing.

## Decisions (confirmed 2026-10-06)

| Question | Decision |
|---|---|
| Who reads it | Apricart's own directors, **every tenant**. Super Admin reads it too. |
| Role | New role `APRICART_EXECUTIVE` ("Apricart Executive"). Read-only, no organization, created by Super Admin only. |
| Which orders count | Approved on/after **2026-09-01 00:00 Asia/Karachi**. Orders brought in by the legacy importers (`legacy_order_imports`) are excluded whatever their date — their timestamps are import times. |
| SLA | **72 calendar hours** from `approved_at` to `delivered_at`. One rule for every location in this release. |
| Due soon | The last **12 hours** before the deadline. |
| Region | New `branches.region` (`NORTH` / `CENTRAL` / `SOUTH`), set by Super Admin in the branch form. Every branch starts *Unknown*. |
| City | The order's delivery-address city when it was sent somewhere else, otherwise the branch city. Blank shows *Unknown*. |
| Stages | The four that exist: Not Started → In Process → Out for Delivery → Delivered. No change to the fulfilment state machine. |
| "Today" | The Asia/Karachi calendar day. |

Constants live in `lib/delivery-sla.ts` (`DELIVERY_SLA_HOURS`,
`DUE_SOON_HOURS`, `DELIVERY_DASHBOARD_CUTOFF`) and the UI prints them, so the
rule on the screen is the rule in the code.

## What counts, and how health is decided

The population: `orders.approved_at >= cutoff`, `status` in `APPROVED` or a
fulfilled status (`FULFILLED`, `PARTIAL`, `PARTIALLY_FULFILLED`), and no
`legacy_order_imports` row. Pending, rejected, cancelled and refunded orders are
not delivery work and do not appear.

* **Open** = `APPROVED` and not `DELIVERED` — exactly the existing `UNFULFILLED`
  bucket (`lib/order-delivery-status.ts`), so this cannot disagree with the
  Viewer dashboard.
* `promisedAt = approvedAt + 72h`.
* Open: `OVERDUE` if now > promisedAt; else `DUE_SOON` if within 12h; else
  `ON_TRACK`.
* Delivered (fulfilment status `DELIVERED`): `DELIVERED_ON_TIME` if
  `deliveredAt <= promisedAt`, else `DELIVERED_LATE`. A delivered order with no
  `deliveredAt` is `DELIVERED_UNTIMED` and is left out of every duration figure
  rather than guessed.

Health is **computed at read time** by one pure function, never stored: it
changes with the clock. The KPI cards, the attention table, the breakdowns and
the timeline all call it, so no two can disagree.

`delivered_at` is reliable for this: it is written once, by the progress route,
the first time an order reaches `DELIVERED` (`COALESCE("delivered_at", NOW())`
in `lib/order-select.ts`), and fulfilment never overwrites it.

## Data

Migration `20261007120000_add_branch_region_and_apricart_executive.sql`
(additive):

* `branches.region varchar(16) NULL` with `branches_region_ck`
  (`NULL` or one of the three). New column, every row NULL, nothing to reject.
* The `APRICART_EXECUTIVE` row in `roles`, inserted here rather than by
  re-running the general seed against production (the seed rewrites
  `role_permissions`), as `ORDER_DESK`'s was.

Rollback: delete the role row when no user holds it; drop the check and the
column.

No index is added. The population query filters on `status` (indexed) and
`approved_at`, and is bounded (below). If it slows, an index on
`(approved_at) WHERE approved_at IS NOT NULL` is the next step, created
concurrently.

## API

Both `GET`, both `SUPER_ADMIN` and `APRICART_EXECUTIVE` only; every other role
403.

| Path | Returns |
|---|---|
| `/api/v1/delivery-dashboard` | KPIs, attention list, by-city / by-region / by-branch, pipeline, overdue age buckets, delivered metrics, filter options |
| `/api/v1/delivery-dashboard/orders/{id}/timeline` | One order's journey: placed, approved, each stage move, promised, delivered |

Filters (query string, each validated, unknown values 400): `organizationId`,
`region`, `city`, `branchId`, `fulfillmentStatus`, `health`, `from`/`to`
(approval date, Karachi days). `branchId` is honoured only together with an
`organizationId` that owns it.

The population is read once per request, capped at
`DELIVERY_DASHBOARD_MAX_ROWS` (20,000) with a `truncated` flag in the
response; the attention list returns at most 100 rows.

The timeline is read from the order row and the `audit_logs` trail
(`ORDER_APPROVED`, `ORDER_FULFILLMENT_STATUS_UPDATE` — recorded with entity
`Order`, capitalised, by the progress route; both spellings are read), and only
for an order inside the dashboard's population, so the endpoint cannot be used
to read arbitrary orders.

**No money and no people.** Neither response carries an amount, a price, a
name, an email or a phone number. Actors on the timeline appear as their role.
Price visibility therefore never comes into it.

## The role

`lib/apricart-executive-access.ts` is the one statement of it, modelled on
`ORDER_DESK`:

* **No organization, no branch.** `POST /api/v1/users` refuses either for this
  role; the access route refuses switching an account into or out of it.
* **Only Super Admin creates or manages one** — `ROLE_LEVEL` 7, beside
  `ORDER_DESK`, so Head Office (6) cannot.
* **Pages:** confined to `/executive` (plus `/change-password`).
* **API:** `proxy.ts` refuses it every call outside
  `APRICART_EXECUTIVE_API_RULES` — the two dashboard reads. This is in addition
  to each route's own `requireApiRole`, never instead of it: most handlers
  check roles inline and a null organization can read as "no tenant filter".
  Order creation is already allowlisted (`lib/order-creation-access.ts`) and
  this role is not on it.
* The route re-reads the account from `users` (active, not deleted, role
  unchanged) on every request.

## UI

* `/executive` — the executive's own workspace (layout and header of its own,
  like `/order-desk`; no admin shell, no organization context).
* `/delivery-dashboard` — the same dashboard inside the admin shell, Super
  Admin only, linked from the sidebar.
* Super Admin creates an executive from the existing Create User dialog
  ("Apricart Executive", no organization field).
* Branch region: a select in Super Admin's create and edit branch forms.

## Tests

* Unit — `lib/delivery-sla.test.ts` (every health boundary, untimed delivery,
  Karachi "today", buckets, attention ordering, summaries);
  `lib/branch-region.test.ts`; `lib/apricart-executive-access.test.ts` (the API
  allowlist matches the routes and admits no mutating handler; areas; shape and
  access-change rules); proxy, RBAC and user-policy additions.
* Integration — `tests/integration/delivery-dashboard-api.test.ts`: the
  hand-worked oracle across two tenants (each health state, cutoff, legacy
  exclusion, pending/rejected excluded, delivery-address city), filters,
  401/403 for every other role, the timeline and its population fence, a
  branch-region round trip, and executive account creation rules.

## Out of scope (later phases of the source plan)

Delay reasons, per-city/branch SLA configuration, business hours and holidays,
new fulfilment stages, notifications, PO attachments.
