# OF-WAREHOUSE — Warehouses as owners of orders, and order transfer

## Goal

Let Super Admin (and, later, the order's warehouse Executive) move one order
from one Apricart warehouse to another, so the target warehouse's staff pick,
dispatch and deliver it and the source warehouse's staff stop seeing it.

Today there is no warehouse entity. A `WAREHOUSE` user reaches the approved
orders of the branches assigned to it — one by one (`warehouse_assignments`)
or by city of chosen organizations (`warehouse_city_assignments` ∩
`warehouse_city_organizations`) — re-read on every request by
`loadWarehouseReach` (`lib/server/warehouse-scope.ts`). Several warehouse
users may serve the same branch (`warehouse_assignments_user_branch_uq` is per
user), so an order has no single operational owner and nothing to transfer
*from*. Executives are a separate reach: organizations
(`apricart_executive_assignments`), and only for pending Order Desk orders.

## Findings that shape the design

Verified against the code on 2026-10-21:

1. An order belongs to a customer branch through `orders.branch_id`. That
   column carries tenant integrity (`orders_branch_org_fk`), budgets, delivery
   addresses, invoices and reporting. **A transfer never changes it.**
2. Every warehouse order read and write — queue, detail, invoice, challan,
   upload, progress, workload, timeline, notifications — authorizes through
   `orders.branch_id ∈ loadWarehouseReach()`.
3. The support queue (`supportBranchReachCondition`) and the read-only
   catalogue fence (`loadWarehouseCatalogFence`) use the same branch reach.
4. Executive approval reach is organization-based and deliberately ignores
   `managed_ordering` and organization status, "or an un-managed tenant's
   pending desk orders (and their holds and stock) would have no one to decide
   them" (`plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md`).
5. Inventory is global; a transfer moves responsibility, not stock.
6. The department sign-up attaches a branch it creates to the warehouses
   serving its city (`attachNewBranchToCityWarehouses`) — the only Head Office
   path that changes a warehouse's reach.

## Target model

```
Customer branch ──default route──> Apricart warehouse
orders.branch_id (unchanged)       orders.fulfillment_warehouse_id (transferable)
                                       ├─ Warehouse operator(s)
                                       └─ Apricart Executive(s)
```

* `apricart_warehouses` — a stable operational owner (code, name, location,
  contact, `ACTIVE`/`INACTIVE`, never deleted).
* `apricart_warehouse_memberships` — `WAREHOUSE_OPERATOR` (a `WAREHOUSE`
  account) or `EXECUTIVE` (an `APRICART_EXECUTIVE` account). The
  responsibility is derived from the account's role on the server, never sent.
* `branch_fulfillment_routes` — one default warehouse per branch, used only to
  stamp new orders.
* `orders.fulfillment_warehouse_id` — the order's current warehouse (phase 2).
* `order_warehouse_transfers` — append-only transfer history (phase 3).

Orders are never assigned to a user account: accounts are deactivated and
replaced, the warehouse stays.

## Phasing — why this change stops after phase 1

The goal can only be met by changing **who sees and acts on which order** for
the warehouse and executive accounts already in production. That change cannot
be made safely until three things exist that are not code:

1. **An approved mapping of today's warehouse accounts to warehouses.** Where
   two accounts serve one branch the system cannot choose an owner; the plan
   forbids guessing.
2. **A decision on executives.** Coupling executive approval to warehouse
   membership (as the original proposal does) removes approval authority from
   every executive not yet a member, and leaves a desk order at a branch with
   no route — or a route to a warehouse with no executive for that
   organization — with **no decider**, holding its budget and stock. That
   contradicts finding 4. Phase 2 needs an explicit fallback rule (e.g. "no
   executive member for this organization → the organization-assigned
   executives decide, as today") chosen by the business.
3. **A decision on unassigned orders.** Fail-closed (only Super Admin sees an
   order with no warehouse) means any branch without a route — including every
   branch the department sign-up creates from then on — drops out of the
   warehouse queue on the day reads switch. Either every branch must be routed
   first (and the join approval must write a route), or reads fall back to the
   branch reach while the order has no warehouse.

Phase 1 therefore builds only what changes nothing for any existing user and
produces the information those decisions need.

### Phase 1 — warehouses, members, routes, coverage (this change)

* Migration `20261029120000_apricart_warehouses`: the three configuration
  tables above. Additive; **no change to `orders` or to any existing table**.
* Super Admin only, on the existing Warehouse Team page (`/warehouse-team`), in
  a new "Warehouses" section above the accounts:
  * `GET /api/v1/apricart-warehouses` — warehouses, members, routes, candidate
    accounts, and the coverage report;
  * `POST /api/v1/apricart-warehouses` — create (code unique, upper-cased);
  * `PATCH /api/v1/apricart-warehouses/[id]` — name, city, address, contact,
    status; deactivating is refused (409) while any branch routes to it;
  * `PUT /api/v1/apricart-warehouses/[id]/members` — `{ userId, assigned }`,
    one account per request; the target must be an active, undeleted
    `WAREHOUSE` or `APRICART_EXECUTIVE` account (else 404, so the route cannot
    probe other accounts);
  * `PUT /api/v1/apricart-warehouses/[id]/branches` — `{ organizationId,
    branchIds }`: the branches of that organization routed to this warehouse
    become exactly the list (one organization per request, under the WAF's
    8 KB); a listed branch routed elsewhere is moved, and the audit row names
    where from; an inactive warehouse takes no new branch (409).
* Every write takes the warehouse row `FOR UPDATE` and records an audit row in
  the same transaction: `CREATE_APRICART_WAREHOUSE`,
  `UPDATE_APRICART_WAREHOUSE`, `UPDATE_APRICART_WAREHOUSE_MEMBERS`,
  `UPDATE_BRANCH_FULFILLMENT_ROUTES`.
* **The coverage report** (the read-only reconciliation the rollout needs),
  computed from the live reach through `loadWarehouseReach` — no second copy of
  the city rule — for every active branch:
  * `ROUTED` — has a route; flagged when no account serving the branch today is
    an operator of the routed warehouse (the owner would change at the switch);
  * `SUGGESTED` — no route; the active accounts serving it today are operators
    of exactly one warehouse;
  * `AMBIGUOUS` — no route; they are operators of more than one;
  * `UNMAPPED` — no route; accounts serve it but none is a member anywhere;
  * `UNSERVED` — no route and no active account serves it.
  Plus inactive warehouse accounts still holding assignments, and per
  warehouse the organizations it is routed into that none of its executive
  members holds an approval assignment for. The pure classification is
  `lib/apricart-warehouses.ts`. Suggestions are applied only by Super Admin
  ticking them in the branch dialog — nothing is applied automatically.

Nothing in phase 1 is read by an order, a reach, a notification or a decision.
`loadWarehouseReach`, `loadExecutiveApprovalReach` and both order-creation
paths are untouched, and `tests/integration/apricart-warehouses-api.test.ts`
asserts the reach of every account is the same after configuration as before.

### Phase 2 — ownership (not built; needs decisions 1–3)

* Migration: `orders.fulfillment_warehouse_id` (nullable, FK, no cascade,
  partial index on `(fulfillment_warehouse_id, status)`), written only when set
  so every other INSERT is unchanged, and read defensively in
  `orderSelectColumns` like `approval_level`.
* Stamp it in both creation paths (`app/api/v1/orders/route.ts`,
  `lib/server/group-order-creation.ts`, each child by its own branch) from
  `branch_fulfillment_routes`; route the department sign-up's new branches.
* Backfill open orders whose branch has a route; report the rest.
* A code constant (like `PASSWORD_CHANGE_EMAIL_VERIFICATION`) switches the
  order-specific warehouse reads (finding 2) and the warehouse notification
  recipients from branch reach to current-warehouse membership. Support and
  catalogue stay on branch reach.
* Executive decision authority per decision 2.

### Phase 3 — transfer (not built)

`transferOrderWarehouse`: order `FOR UPDATE`, actor and memberships re-read,
`{ targetWarehouseId, reason, expectedWarehouseId, expectedUpdatedAt }`
(strict), allowed while `PENDING` or `APPROVED` at `NOT_STARTED`/`IN_PROCESS`,
never once out for delivery or terminal; `approved_at`, the SLA clock, stage
and invoice untouched; history row, `ORDER_WAREHOUSE_TRANSFERRED` audit and
in/out notifications in the same transaction; progress, decisions and transfer
compare the same warehouse so a race has one winner. Super Admin first;
executive transfer after decision 2.

## Security

* Super Admin only, checked in every handler (`requireApiRole`), behind the
  existing `/warehouse-team` page gate. Desk, executive, support and warehouse
  sessions are refused these paths by their proxy allowlists before a handler
  runs; the warehouse isolation and write sweeps call the new handlers directly
  as a warehouse user.
* Strict Zod bodies; ids from the path are validated; a member's
  responsibility comes from the account row, never the body.
* Warehouses are Apricart's, not a tenant's: no `organization_id`, so the
  composite tenant keys do not apply. A route ties a branch to a warehouse and
  carries no tenant data of its own; the branch write is fenced to the
  organization named in the body.
* Responses are `private, no-store` and carry no prices or tenant figures.

## Rollout

1. Apply `20261029120000` (`npm run db:migrate:prod`), then deploy. The code
   reads the new tables only on the Warehouse Team page; before the migration
   only that section fails.
2. Super Admin creates warehouses, adds members, and routes branches, working
   from the coverage report until nothing is `AMBIGUOUS` or `UNMAPPED`.
3. Business decisions 1–3, then phase 2.

Rollback: hide the section by redeploying the previous code; then
`DROP TABLE branch_fulfillment_routes, apricart_warehouse_memberships,
apricart_warehouses;` — nothing else references them.
