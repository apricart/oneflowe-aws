# OF-WAREHOUSE — Apricart Warehouse role: picking, dispatch, delivery and refund remarks

Status: **Phase 1 implemented (2026-10-07) — unit, contract and integration gates green on the test database; migration `20261011120000` applied to the test database only, not to staging or production. Phase 2 proposed.**
Date: 2026-10-07
Jira: _to be assigned_
Builds on: `plans/OF-ORDER-DESK-internal-order-entry.md`,
`plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md`,
`plans/OF-DELIVERY-management-delivery-dashboard.md`,
`plans/OF-DELIVERY-CHALLAN-proof-of-delivery.md`,
`plans/OF-REFUND-seven-day-requester-window.md`

### Revision 2026-10-07 — decisions from the requester

| Question | Answer |
|---|---|
| Reach | **Branches only, never a whole organization.** Super Admin assigns as many branches as it likes, from any organizations. A branch opened later is not reached until it is assigned — unless it is in a city assigned as a whole (revision 2026-10-08, `plans/OF-WAREHOUSE-city-assignments.md`). |
| Challan | **Optional for the warehouse.** It may attach one when marking delivered, attach one later to a delivered order that has none, or deliver without one. Super Admin's own delivery route still requires one. |
| Prices | **The warehouse sees prices and invoice information** — line prices, tax, totals, invoice number, payment status, refunded amount. The org-level price-hiding settings apply only to Branch Admin and Order Portal, so nothing there changes. The invoice PDF is not opened to it in Phase 1 (the invoice access policy is tenant-scoped). |
| Warehouse owner (OPEN-1) | Apricart's own warehouse, cross-tenant — as assumed. |
| Stock (OPEN-2) | All global products, read-only. Since replaced by the Product Catalog tab — `plans/OF-WAREHOUSE-read-only-product-catalog.md`. |

OPEN-3 and OPEN-4 belong to Phase 2 and stay open.

---

## 1. What was asked

A new **Warehouse** role that works the approved orders of the branches
assigned to it (revision 2026-10-07: branches only, never a whole organization):

| Activity | In this plan |
|---|---|
| View assigned approved orders | Phase 1 — only assigned branches |
| View picking details (code, item, qty, unit, notes, destination) | Phase 1 |
| Monitor workload (open, due soon, overdue, delivered) | Phase 1 — the existing SLA rules, fenced to the reach |
| `NOT_STARTED → IN_PROCESS` | Phase 1 |
| `IN_PROCESS → OUT_FOR_DELIVERY` | Phase 1 |
| `OUT_FOR_DELIVERY → DELIVERED`, challan optional (revision) | Phase 1 |
| View challan and timeline, in scope | Phase 1 |
| Export picking/dispatch list — with prices (revision) | Phase 1 |
| View available stock, read-only | Phase 1 |
| **Remark on an order's refund request; Super Admin or Executive then approves or rejects** | Phase 2 |
| View supplier contacts | **Not planned** — see F8 |
| Stock receipt / damage / count correction | Phase 3, separate plan |
| Returned-goods inspection | Phase 3, separate plan (the Phase 2 remark is its precursor) |

### Acceptance criteria

- AC1 A warehouse user sees only `APPROVED` orders (plus delivered/fulfilled
  history) at branches inside its assignment; anything else reads as **404**.
- AC2 Picking details and the export carry line prices, tax, totals, invoice
  number and payment status (revision 2026-10-07). The workload view stays the
  management dashboard's, which carries no amount.
- AC3 The warehouse moves an order forward exactly one stage at a time; it can
  never skip a stage, step back, or move an order that is not `APPROVED`.
- AC4 A challan is optional for the warehouse. When one is named it must be an
  unattached upload by the same warehouse user for that order, attached in the
  same transaction — otherwise nothing changes. A delivered order with no
  current challan may have one attached later by an in-reach warehouse user.
- AC5 A delivery recorded by the warehouse has exactly the effects of one
  recorded by Super Admin: `delivered_at` written once, a waiting token hand-off
  settles the order, the timeline and the delivery dashboard show it.
- AC6 The warehouse can never fulfil, approve, reject, cancel, edit, price,
  refund, or change payment status.
- AC7 The warehouse adds a remark to a `PENDING` refund request inside its
  reach; it sees the requested items and quantities and the requester's reason,
  never an amount.
- AC8 Super Admin, and an Executive granted refund decisions for that
  organization, see the remark when approving or rejecting the request.
- AC9 Only Super Admin creates a warehouse user or changes its assignment;
  every change is audited.
- AC10 Nothing changes for any role that is not Warehouse or Executive.

## 2. Findings that shaped the design

- **F1 — The pattern already exists twice.** `ORDER_DESK` and
  `APRICART_EXECUTIVE` are Apricart staff with **no organization**, a reach
  table of their own re-read on every request (`order_desk_assignments`,
  `apricart_executive_assignments`), a `ROLE_LEVEL` of 7 so only Super Admin
  manages them (`lib/server/user-access-policy.ts`), one page area
  (`SINGLE_AREA_ROLES` in `proxy.ts`) and an **API allowlist** enforced in
  `proxy.ts` before any handler runs, with a contract test proving each listed
  handler checks the role itself. Warehouse is the third of these. The
  executive role touched ~40 files; that is the realistic footprint here too.
- **F2 — Delivery progress is already a safe state machine.**
  `POST /api/v1/orders/[id]/fulfillment-status` is Super Admin only, but the
  write it does is `transitionOrderFulfillmentStatusColumn`
  (`lib/order-select.ts`), a compare-and-set that requires `status = 'APPROVED'`
  **and** the expected current stage in its `WHERE`. A cancelled order, a
  concurrent move by Super Admin, or a double click all fall out as `conflict`
  (409). `delivered_at` is written by `COALESCE`, so only once.
- **F3 — The challan already binds to its uploader.** `attachDeliveryChallan`
  matches this order, this uploader, not yet attached, inside the delivery
  transaction. A warehouse upload therefore can only ever be attached by the
  same warehouse user. Upload goes through `POST /api/v1/upload/image`
  (`purpose=delivery-challan`), today Super Admin only — the one path the WAF
  allows, so we **widen that purpose's role check, not add a new upload route**.
- **F4 — Order reads leak prices if reused.** `GET /api/v1/orders/[id]` and
  `canReadOrderDetail` serve tenant roles and return priced rows. The warehouse
  must not join `ORDER_DETAIL_READ_ROLES`; it gets its own read with an explicit
  column list (product code, name, quantity, unit, notes, destination).
- **F5 — The workload view is the delivery dashboard, unfenced.**
  `loadDeliveryDashboard` and `loadDeliveryTimeline`
  (`lib/server/delivery-dashboard.ts`) read every tenant, deliberately, for
  management. The SLA rules (`assessDelivery`, 72 h, due soon in last 24) are
  exactly what the warehouse needs; the query needs a reach predicate added.
  The dashboard response already carries no amount and no person.
- **F6 — Stock is one global number.** `global_products.stock_quantity` is the
  single source of truth (decremented on every order). A read-only stock view
  selects code, name, unit, stock, status — never `base_price`.
- **F7 — Refund decisions are inline in two Super Admin routes.**
  `POST /api/v1/admin/refunds` (approve: row lock, budget credit to the order's
  own period, refund rows, audit) and `PATCH /api/v1/admin/refunds/[id]`
  (reject → `CANCELLED`) both check `role !== "SUPER_ADMIN"` inline and hold the
  logic in the handler. Letting an Executive decide **requires extracting that
  logic into `lib/server/`** first, or the money path gets written twice.
  Today Executives see no money at all.
- **F8 — "Suppliers" are the customer's, not Apricart's.** `suppliers` rows are
  per tenant **branch** (`organization_id`, `branch_id` not null), maintained by
  the tenant. They are not the warehouse's inbound suppliers. Showing them to
  Apricart's warehouse would expose tenant data for no stated use. Dropped
  unless a real Apricart supplier list is designed.
- **F9 — No partial or failed delivery exists.** The stage list is strictly
  forward (`getNextFulfillmentStatus`). A failed delivery attempt cannot be
  recorded today; this plan does not add one (see Risks).

## 3. Decisions

### D1 — Warehouse is Apricart staff, cross-tenant, assignment-scoped
Role name `WAREHOUSE`, label "Warehouse (Apricart)". No organization or branch
on the user row; `ROLE_LEVEL` 7; created only by Super Admin; role can never be
switched into or out of (same guards as `apricartExecutiveAccessChangeError`).
**OPEN-1:** confirm the warehouse is Apricart's, not a tenant's own store. If a
tenant needs its own warehouse later, that is a different role with an
organization.

### D2 — Reach: a `warehouse_assignments` table of branches
`(user_id, branch_id NOT NULL)`, unique per pair — **no organization-wide
row** (revision 2026-10-07). The organization is always the branch's own,
read through the join, so it can never disagree with the branch. Written only
by Super Admin on its own `/warehouse-team` page (moved off `/desk-team` on 2026-10-08 — the warehouse has nothing to do with the Order Desk), one organization at a time
(`PUT /api/v1/warehouse-team/{userId}/branches` with `{ organizationId,
branchIds }` replaces that user's branches *in that organization*), which keeps
each body far under the WAF's 8 KB limit however many branches are assigned
overall. Audited `UPDATE_WAREHOUSE_ASSIGNMENTS`.
Not gated on `managed_ordering` — every tenant's orders need delivering. Never
`user_branch_assignments` (feeds group-role reports). Pure rule
`resolveWarehouseReach` in `lib/warehouse-access.ts`; loader in
`lib/server/warehouse-scope.ts` re-reads the account (active, not deleted, still
`WAREHOUSE`) and, inside a write transaction, the assignment `FOR SHARE`.
Empty reach = nothing, never "every tenant".

### D3 — One progress core, two callers
Extract the body of the fulfillment-status route into
`progressOrderFulfillment(tx, { orderId, nextStatus, actor, deliveryChallanId })`
in `lib/server/order-fulfillment-progress.ts`: the transition, the challan
attach, the `ORDER_FULFILLMENT_STATUS_UPDATE` audit row (now with
`actorRole`), and — after commit — the token hand-off settle. The Super Admin
route keeps its URL and behaviour and calls it; the warehouse route
`POST /api/v1/warehouse/orders/[id]/progress` checks role + reach (`FOR SHARE`)
and calls the same function. CLAUDE.md's "delivery is recorded only through
`POST /api/v1/orders/[id]/fulfillment-status`" becomes "only through
`progressOrderFulfillment`", and the contract test pins both callers. The
warehouse **never** calls `fulfillApprovedOrder`.

### D4 — Challan upload and read (optional for the warehouse — revision)
The challan is **optional** when the warehouse marks an order delivered; a
delivered order with no current challan may have one added later
(`POST /api/v1/warehouse/orders/[id]/delivery-challan`). Super Admin's route
still requires one. `POST /api/v1/upload/image` with `purpose=delivery-challan` admits `WAREHOUSE`
when the `orderId` is inside its reach and the order is out for delivery or
delivered (any other purpose is 403 for the role); storage, `sharp`, `inspectPdfUpload` unchanged. Reads via
`GET /api/v1/warehouse/orders/[id]/delivery-challan` (+ `/file`), fenced by
warehouse reach, same headers as the existing reader. **Replacing** a challan
stays Super Admin only.

### D5 — Reads (prices and invoice figures included — revision)
Under `/api/v1/warehouse/`, each with role + reach + rate limit + bounded
pagination:
- `GET orders` — the queue: approved orders in reach, filter by stage / health /
  organization / branch, sort allowlisted (`lib/list-sort-keys.ts`), default 50,
  max 200. Rows: order id/tid, organization, branch, destination city/address,
  stage, approved at, promised at, health, item count.
- `GET orders/[id]` — picking sheet: lines with product code, name, quantity,
  unit; order notes; delivery address (else branch address); stage; challan
  presence.
- `GET orders/[id]/timeline` — `loadDeliveryTimeline` with the reach predicate.
- `GET workload` — `loadDeliveryDashboard` with a new optional
  `reach` condition (organization/branch pairs) in `filterConditions`. The
  management dashboard passes no reach and is unchanged.
- `GET stock` — global products: code, name, unit, stock, active; search +
  pagination. **OPEN-2:** all global products, or only products listed at
  branches in reach? Recommend all (it is Apricart's own stock).

Each response is built by a named mapper with an explicit field list. Since
the revision it carries line prices, tax, totals, invoice number, payment
status and refunded amount; it still carries no person behind the order
(creator, approver, requester phone), which the integration suite checks.

### D6 — Export
Client-side XLSX/CSV (existing `xlsx` dependency) from the queue with
`lines=1`: one row per order line, with unit price and line amount. The
export reads at most 10 pages of 100 orders of the current filter.

### D7 — Refund remarks (Phase 2)
- New table `refund_warehouse_remarks` (`id, refund_id, author_user_id,
  condition, note, created_at`), **append-only** like audit rows; `condition` ∈
  `GOODS_OK | GOODS_DAMAGED | GOODS_NOT_RETURNED | QUANTITY_MISMATCH | OTHER`,
  `note` 1–1000 chars (well under the 8 KB WAF body limit).
- `GET /api/v1/warehouse/refunds` lists `PENDING` refund requests on orders in
  reach: refund number, order tid, branch, requested items + quantities,
  requester reason, existing remarks. **No amounts.**
- `POST /api/v1/warehouse/refunds/[id]/remarks` — reach re-read `FOR SHARE`,
  refund row locked and still `PENDING`, audited `ADD_REFUND_WAREHOUSE_REMARK`.
  Rate limited. Remarks on a decided refund are 409.
- Super Admin's `RefundManagement` and the Executive's refund queue show the
  remarks beside each request.
- **OPEN-3:** is a remark **required** before a decision? Recommend **advisory**
  (shown, with an "awaiting warehouse remark" badge and a confirm in the
  decision dialog), because a hard gate leaves a refund undecidable whenever no
  warehouse user is assigned to that branch. A per-organization "require
  warehouse remark" switch can follow if wanted.

### D8 — Executives decide refund requests (Phase 2)
- **Separate, opt-in grant**: `apricart_executive_assignments.decides_refunds
  boolean NOT NULL DEFAULT false`. Existing assignments (desk-order approval)
  do not silently gain financial authority; Super Admin ticks it per
  executive per organization on `/desk-team`, audited.
- First, extract the Super Admin approve/reject logic (F7) into
  `lib/server/refund-decision.ts` (`approveRefundRequest`, `rejectRefundRequest`),
  with the existing integration suites as the regression net. Super Admin
  routes keep their URLs, bodies and responses.
- Executive routes `GET /api/v1/executive/refunds`,
  `POST .../[id]/approve`, `POST .../[id]/reject` (reason required), added to
  `APRICART_EXECUTIVE_API_RULES`. Reach re-read `FOR SHARE` in the deciding
  transaction; outside reach = 404.
- **The executive approves the request as raised** — same items, same
  quantities, carrying `expectedUpdatedAt` of the request (409 if it changed).
  Item edits at approval time and direct refunds without a request stay Super
  Admin only. Budget credit lands on the order's own period exactly as today
  (`budgetPeriodOf(order.createdAt)`); `orderTakesBudget(order)` still decides
  whether any budget moves.
- This is the first time an Executive sees money. The refund screens show
  amounts; the delivery dashboard stays amount-free.
- **OPEN-4:** all refund requests in the granted organizations, or only those
  on Order Desk orders? Recommend all — the refund belongs to the order, not to
  who keyed it.

### D9 — Workspace
`/warehouse` page area outside the admin shell (like `/executive`): Queue,
Order (picking sheet + progress buttons + challan upload), Workload, Stock, and
in Phase 2 Refund remarks. Progress buttons disable in flight; the server's
compare-and-set is the real double-submit guard.

## 4. Data

| Change | Phase | Notes |
|---|---|---|
| `roles` row `WAREHOUSE` | 1 | Inserted by migration, **not** `db:seed` (seed rewrites `role_permissions`) |
| `warehouse_assignments` | 1 | New table, two partial unique indexes, FK cascade on user/org/branch |
| `refund_warehouse_remarks` | 2 | New table, FK to `refunds`, CHECK on `condition` and note length |
| `apricart_executive_assignments.decides_refunds` | 2 | Additive, default `false` — changes nothing on apply |

All additive; no backfill; lock time negligible (two new tables, one defaulted
column on a small table). Migration `when` must be raised above the last
applied journal entry (`20261010120000`) by ≥ 3 600 000, per this repo's
journal ordering. Rollback: deactivate warehouse accounts, drop the new tables
and column, delete the role row if no user holds it.

Code also touched: `systemRoleSchema`, `lib/rbac.ts` (`Role`, hierarchy),
`ROLE_LEVEL`, `ROLE_TEMPLATES` (descriptive keys only — `ORDER_VIEW`,
`INVENTORY_VIEW`), login redirect, create-user dialog, user tables,
`proxy.ts` (`SINGLE_AREA_ROLES`, `ROLE_GATED_AREAS`, API allowlist block).

## 5. Security

- **No organization on the caller.** The classic failure is an inline
  `if (orgId) where(orgId)` that becomes "no filter". Mitigation: the proxy
  allowlist (`WAREHOUSE_API_RULES`, exact-match regexes) refuses every other
  API path, and `lib/warehouse-access.test.ts` proves each listed handler calls
  `requireApiRole(["WAREHOUSE"])` (or the shared role list) and the reach
  loader. Proxy is a second layer, not the boundary.
- **IDOR.** Every `[id]` route resolves the order's organization and branch and
  checks it against the re-read reach; out of reach is 404, consistently.
- **Price leakage.** Dedicated mappers + the key-name contract test (D5);
  `lib/price-visibility.ts` is not relied on because the warehouse never
  receives a priced row in the first place.
- **Write races.** Progress: compare-and-set (F2) + reach `FOR SHARE`. Remark:
  refund row `FOR UPDATE`, status re-checked. Executive refund decision: the
  same locked path as Super Admin's, plus `expectedUpdatedAt`.
- **Vertical escalation.** Warehouse holds no route that fulfils, decides,
  prices, cancels, or refunds; the existing Super Admin/desk routes keep their
  role checks and are added as negative cases to the tests.
- **Uploads.** No new upload path; challan purpose widened with reach and stage
  checks; PDF inspection and private prefix unchanged.
- **Audit.** Every progress step (with `actorRole: WAREHOUSE`), challan upload,
  remark, assignment change, and executive refund decision writes an audit row
  in the same transaction; add each new action to
  `lib/server/activity-audit-coverage.test.ts`.
- **Rate limits.** `search` bucket on list/workload/stock reads; a write bucket
  on progress and remarks.

## 6. Tests

Unit / contract (`npm test`):
- `lib/warehouse-access.test.ts` — reach resolution (org-wide, single branch,
  inactive, deleted, wrong role, empty), allowlist exact matching, every
  allowlisted handler checks role + reach.
- Response-mapper contract — no money-shaped key in any warehouse response.
- `lib/server/budget-consumption-contract.test.ts`, refund-window contract,
  activity-audit coverage — new callers and actions listed.
- Progress-core contract: both callers go through `progressOrderFulfillment`;
  nothing else writes `fulfillment_status` or `delivered_at`.

Integration (`npm run test:integration`, confirm stderr says "running against"):
- `tests/integration/warehouse-api.test.ts` — 401 / 403 per role / success /
  cross-tenant 404 / branch-only assignment cannot see sibling branch; stage
  skip, step back, non-approved, cancelled-mid-flight, concurrent Super Admin
  move (409); delivered without challan, with another user's challan, with a
  used challan; token hand-off settles on warehouse delivery.
- `tests/integration/warehouse-refund-remarks.test.ts` — remark in/out of
  reach, on decided refund (409), amounts absent.
- `tests/integration/executive-refund-decision.test.ts` — grant off = 404,
  grant on = approve credits the order's own period (cross-month case),
  reject → `CANCELLED`, stale `expectedUpdatedAt` 409, double approve once.
- Existing refund and delivery-challan suites run unchanged against the
  extracted cores — they are the regression proof for D3 and D8.

E2E: one Playwright spec — warehouse moves an order through to delivered with
a challan; Super Admin sees it delivered.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Extracting the refund approval (budget credit) changes money behaviour | Phase 2 starts with a pure extraction PR, no new caller, existing suites green before and after |
| A handler not on the allowlist is later added to it without a reach check | Allowlist contract test fails the build |
| Two people (Super Admin and warehouse) record the same delivery | Compare-and-set; second gets 409 and a refresh |
| No way to record a failed delivery or undo a wrong stage | Out of scope; Super Admin-only correction to be planned separately if needed |
| Warehouse assigned to nothing ⇒ refund remarks never come | Remarks advisory (OPEN-3) |
| Executive now sees refund money | Explicit opt-in grant per organization; amounts only on refund screens |
| Migration not applied before deploy | New tables are selected by the new routes only; still apply first, as with every recent migration |

## 8. Steps

**Phase 1 — role and delivery (one PR per bullet group)**
1. Extract `progressOrderFulfillment`; Super Admin route calls it. No behaviour change.
2. Migration (role row, `warehouse_assignments`), role plumbing, `lib/warehouse-access.ts`, `lib/server/warehouse-scope.ts`, proxy area + allowlist, Super Admin assignment UI.
3. Warehouse reads (queue, picking, timeline, workload, stock) + export.
4. Warehouse progress route + challan upload/read.
5. Tests, CLAUDE.md update, Playwright spec.

**Phase 2 — refunds**
6. Extract `approveRefundRequest` / `rejectRefundRequest`; Super Admin routes call them. No behaviour change.
7. Migration (`refund_warehouse_remarks`, `decides_refunds`), warehouse remark routes + UI.
8. Executive refund grant, routes, queue UI; remarks shown to both deciders.
9. Tests, CLAUDE.md update.

**Phase 3 — later, separate plans**
Stock adjustments (receipt / damage / count, append-only movement ledger
against `global_products.stock_quantity`), returned-goods inspection linked to
refund requests, Apricart supplier list if wanted.

---

## 9. Phase 1 — as implemented (2026-10-07)

**Data.** `drizzle/20261011120000_add_warehouse_role.sql`: the `WAREHOUSE`
role row and `warehouse_assignments (user_id, branch_id)` with
`warehouse_assignments_user_branch_uq`. No organization column — the
organization is always the branch's own.

**Shared delivery transition.** `lib/server/order-fulfillment-progress.ts`
(`progressOrderFulfillment`) is the body of Super Admin's
`POST /api/v1/orders/[id]/fulfillment-status`, moved unchanged, with two hooks
(`authorize`, `guardInTransaction`) and `challanRequired`. Super Admin's route
keeps its URL, body, messages and response. The audit row gains
`actorRole`. Five source-reading contract tests that pinned the old route body
now pin the module and both callers (`lib/delivery-challan.test.ts`,
`lib/server/order-delivery-date.test.ts`,
`lib/server/order-token-fulfillment.test.ts`,
`lib/server/activity-audit-coverage.test.ts` — the route moved from
`LEGACY_DIRECT` (38 → 37) to `VIA_LIB`).

**Endpoints** (all `requireApiRole(["WAREHOUSE"])`, all on
`WAREHOUSE_API_RULES`, all 404 outside the reach):

| Route | What |
|---|---|
| `GET /api/v1/warehouse/orders` | Queue: `view=open|delivered|all`, `stage`, `organizationId`, `branchId`, `q`, `days`, `lines`, `page`, `limit` (≤ 100); unknown keys 400; per-stage counts; the user's organizations and branches as filter options |
| `GET /api/v1/warehouse/orders/[id]` | Picking sheet: lines with code, qty, unit, unit price, amount; notes; destination; invoice figures; health; current challan |
| `POST /api/v1/warehouse/orders/[id]/progress` | One stage forward; challan optional on `DELIVERED` |
| `GET /api/v1/warehouse/orders/[id]/timeline` | The dashboard timeline, fenced |
| `GET`/`POST /api/v1/warehouse/orders/[id]/delivery-challan` | Current challan; add one to a delivered order that has none |
| `GET /api/v1/warehouse/orders/[id]/delivery-challan/[challanId]/file` | Stream it, same headers as the order readers' route |
| `GET /api/v1/warehouse/workload` | The management dashboard, fenced (same query, same shape) |
| `GET /api/v1/warehouse/stock` | Global stock, read-only, no price. Removed; see `plans/OF-WAREHOUSE-read-only-product-catalog.md` |
| `GET /api/v1/warehouse-team`, `PUT /api/v1/warehouse-team/[userId]/branches` | Super Admin only |

**UI.** `/warehouse` (Orders, Workload, Stock tabs; picking sheet with the
progress button, optional challan dialog, invoice panel, timeline; Excel/CSV
export). Super Admin assigns branches on its own **Warehouse Team** page (`/warehouse-team`, sidebar entry beside Delivery Dashboard; gated in `proxy.ts`, whose area lookup now matches on a path boundary so `/warehouse-team` is not read as the warehouse's `/warehouse`). Users →
Create user offers "Warehouse (Apricart)" to Super Admin, with no
organization or branch.

**Known limits.**
- The queue includes every approved order at the branches, but the Workload
  tab and the timeline follow the management dashboard's population (approved
  since 2026-09-01, never a legacy import); an older order shows "no timeline".
- The upload rate limit (`upload`, 20 per hour per user) is shared by every
  upload purpose. A warehouse attaching many challans an hour will hit it;
  raising it is a separate, deliberate change.
- ~~The invoice PDF is not opened to the warehouse.~~ Added 2026-10-08 at the requester's ask: `GET /api/v1/warehouse/orders/[id]/invoice`, fenced by branch reach, printing the same document as the customer's download through the shared `buildInvoiceDocument` (`lib/server/invoice-document.ts`, extracted unchanged from `/api/v1/receipts/[orderId]/download`). The PDF names the placer and approver and shows the placer's phone, as every invoice does.
- Challan uploads need S3 (`S3_UPLOADS_BUCKET` + region). Without it the upload is 503 and the dialog now says the order was **not** delivered; on a machine with no S3 configured, deliver without a challan.
- No failed-delivery or step-back state (F9).

**Tests.** Unit/contract: `lib/warehouse-access.test.ts`,
`lib/warehouse-orders.test.ts`, `lib/warehouse-stock.test.ts`,
`lib/warehouse-team-view.test.ts`,
`components/order-desk/warehouse-team-card.test.tsx`,
`components/warehouse/warehouse-order-sheet.test.tsx`. Integration:
`tests/integration/warehouse-api.test.ts` (38 cases: 401/403 role matrix,
branch fence incl. cross-organization and same-organization sibling branch,
inactive and unassigned accounts, stage skip/repeat/back, pending order,
concurrent move, delivery with and without challan, foreign challan rollback,
challan added later and only once, token hand-off settlement, Super Admin
still needing a challan, workload/timeline fence, stock, assignment API
including per-organization replacement and audit). Full integration suite
58 files / 1515 tests green on `oneflowe_test`.

**Isolation audit (2026-10-07).** `tests/integration/warehouse-isolation-sweep.test.ts`
calls every one of the 128 GET handlers under `app/api/v1` directly as a
warehouse user assigned one branch — bypassing `proxy.ts` — with every dynamic
id and every tenant filter pointed at a sibling branch and another tenant,
and searches each successful response for markers planted in those rows.
Every warehouse endpoint held. Three shared analytics handlers did not:
`analytics/branches/performance`, `analytics/budgets/summary` and
`analytics/organization-stats` add the organization filter only when the
session has one, so any organization-less role (Order Desk, Apricart
Executive, Warehouse) read every tenant. The proxy refused those calls, so
nothing was reachable from the running app, but the proxy is not the
boundary. Each now refuses a non-Super-Admin caller with no organization
(`lacksAnalyticsTenant`, `lib/server/analytics-scope.ts`); no tenant role is
affected, since every one carries an organization. Eight other handlers
outside the allowlist answer the role with nothing tenant-shaped (own
records, empty results, the global catalogue) and are listed, with reasons,
in the sweep. By design the warehouse also sees the **global** stock list,
which is Apricart's catalogue rather than any branch's data.

**Deploy order.** Apply `20261011120000` to production → deploy → create
warehouse accounts from Users → assign branches on Warehouse Team.
