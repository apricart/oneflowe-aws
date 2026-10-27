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
Customer branch ──warehouse, resolved live──> Apricart warehouse
  (manual route, else organization+city rule,      └─ Warehouse operator(s)
   else organization rule, else none)                   scope: ALL of the warehouse's
                                                        branches, or SELECTED ones
Order ──orders.fulfillment_warehouse_id if Super Admin transferred it,
        else its branch's warehouse now──> the warehouse that works it

Apricart Executive ──organization assignment──> approves Order Desk orders
(unchanged; warehouse membership is informational only)
```

* `apricart_warehouses` — a stable operational owner (code, name, location,
  contact, `ACTIVE`/`INACTIVE`, never deleted).
* `apricart_warehouse_memberships` — `WAREHOUSE_OPERATOR` (a `WAREHOUSE`
  account) or `EXECUTIVE` (an `APRICART_EXECUTIVE` account). The
  responsibility is derived from the account's role on the server, never sent.
* `branch_fulfillment_routes` — a branch assigned to a warehouse by hand
  (overrides any rule).
* `warehouse_route_rules` (phase 2) — "organization X" or "organization X in
  city Y" → warehouse; evaluated at read time, never copied into rows.
* `orders.fulfillment_warehouse_id` — set **only** by a transfer (phase 3);
  null means "the branch's warehouse, now".
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

### Decisions taken (2026-10-27)

1. **Mapping.** No mapping is guessed. Super Admin names the warehouse for
   each active `WAREHOUSE` account; a script turns that account's cities and
   organizations into rules on that warehouse (2b, "Production mapping"). Reads
   do not switch until `check:warehouse-ownership` shows no account would lose
   anything (phase 2a, decision 5).
2. **Executives are not coupled to warehouses.** Approval of Order Desk orders
   stays on `apricart_executive_assignments` (organizations), exactly as today.
   `EXECUTIVE` membership stays informational (the coverage report's
   "organizations with no executive" hint) and gives no order reach.
3. **Unrouted orders are never hidden.** During the rollout an order with no
   warehouse falls back to today's branch reach. After the cut-over it appears
   only in Super Admin's **Unrouted orders** list, with a dashboard count, until
   its branch is routed or the order is transferred.
4. **One warehouse fulfils a whole order.** Splitting an order across
   warehouses (per-line routing) is out of scope. Confirmed by the business
   on 2026-10-28.
5. **No working warehouse account may lose any order, branch or thread it
   sees today** (2026-10-28, for the production accounts `sheikh.murtaza` and
   `sohail` in particular). This is the acceptance test of phase 2, and it is
   why rules are **evaluated live, never copied into route rows, and orders are
   not stamped**: branches are created by eight paths, seven of them raw-SQL
   scripts, and `scripts/sync-ke.ts` inserts K-Electric branches with no city,
   to be given one later. Today's city reach picks such a branch up the moment
   its city is set; a copied route would not, and neither would a stamp on an
   order raised before. A live rule behaves exactly as the city reach does,
   whichever path writes the branch.

**The model:** branches are assigned to the warehouse, and warehouse users are
assigned to the warehouse — with all of its branches, or a subset of them. A
`WAREHOUSE` account no longer carries branches or cities of its own.

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

### Phase 2 — ownership (planned 2026-10-27; 2b built 2026-10-28; 2c and 2d not started)

**As built (2026-10-28).** Migration `20261104120000_warehouse_route_rules`;
`lib/warehouse-ownership-policy.ts` (mode, shipped `"branch"`);
`lib/server/branch-warehouse.ts` (`branchWarehouseSql`, the only resolver);
the mode switch inside `loadWarehouseReach` and both recipient lists, each of
which runs exactly the pre-phase-2 queries in the `"branch"` mode; rules,
scope, unrouted list and ownership check on Warehouse Team; the two scripts.
Rehearsed end to end on the test database (dry run, a refused plan, a commit
the in-transaction check rolled back, a clean commit, a branch given its city
afterwards, rollback). Tests: `lib/warehouse-ownership.test.ts`,
`tests/integration/warehouse-ownership-phase2.test.ts`, and the existing
warehouse suites and both isolation sweeps unchanged.

Phase 3 below was built first (2026-10-23) and already gives the warehouse an
order column, a single reach rule and transfers. Phase 2 makes the warehouse
the owner of **every** order, from the decisions above. It ships in four steps,
in this order; no step changes who sees an order until 2c, and 2c changes it
for no working account (decision 5).

**Revision 2026-10-28.** The first draft copied rule results into
`branch_fulfillment_routes` and stamped every new order with its warehouse.
Both are dropped: a branch's warehouse is **resolved live** and an order's
warehouse is **its transfer, else its branch's warehouse now** — the same
semantics phase 3 already gives a null `fulfillment_warehouse_id`. This keeps
exact parity with today's city reach whichever of the eight branch-writing
paths creates or edits a branch, keeps historical (fulfilled) orders visible to
the warehouse that serves their branch, and removes the stamping backfill.

#### Production mapping (read-only check, production, 2026-10-28)

| Account | Reach today | Warehouse | Rules to create | Member scope |
|---|---|---|---|---|
| `sheikh.murtaza` | city `karachi` × 4 organizations — 214 branches (K-Electric 175, UBL 33, K-E-Demo 4, Meezan (Demo) 2); 209 open orders | `KARACHI-001` (id 1) | (K-Electric Limited, karachi), (UBL, karachi), (K-E-Demo, karachi), (Meezan (Demo), karachi) | `ALL` |
| `sohail` | city `lahore` × 51 organizations, 16 of which have Lahore branches now — 204 branches; 5 open orders | `LAHORE-001` (id 2) | (organization, lahore) for **every one of the 51** chosen organizations, so their future Lahore branches stay covered | `ALL` |

* Neither account has single-branch assignments; no branch is reached by both;
  no order has been transferred; both warehouses exist with no members and no
  routes.
* `demo_warehouse` had its assignments removed by Super Admin on 2026-10-28
  and is not mapped. Its removal left two EFU orders with **no warehouse
  account**: 2248 (Islamabad Branch, out for delivery) and 2194 (Rawalpindi
  Division, in process) — see 2a.
* The mapping is applied by `npm run migrate:warehouse-city-rules -- --map
  sheikh.murtaza=KARACHI-001 --map sohail=LAHORE-001` (2b): dry-run by default,
  digest-gated `--commit`, rollback report. It reads each account's cities and
  organizations **at run time** (never the table above), writes one rule per
  (organization, city) to the named warehouse and the `ALL` membership, turns
  any single-branch assignment into a manual route, and refuses if two accounts
  would put the same (organization, city) or branch into different warehouses,
  or if an account with assignments is left unmapped.

#### 2a — Data clean-up (no code; prerequisite for 2c)

* Every active warehouse account with assignments is mapped to exactly one
  warehouse (today: the two above).
* Every open order has a warehouse account that sees it, or Super Admin has
  chosen to leave it to the Unrouted list. **Now:** orders 2248 and 2194 (EFU
  Islamabad / Rawalpindi), plus 7 open orders at branches no account has ever
  served — Super Admin assigns those branches to a warehouse account or
  transfers the orders.
* The coverage report gains **"accounts that would lose orders at the
  switch"**. `npm run check:warehouse-ownership` (read-only) computes, for
  every active `WAREHOUSE` account, the set of orders, branches and support
  threads it can see under today's rule and under the warehouse rule, and exits
  non-zero on **any** difference for any account, listing it. 2c is not
  deployed until it passes against production.

#### 2b — Build (changes nothing visible while the mode is `branch`)

**Migration** (additive, one file):

* `warehouse_route_rules` (`id`, `warehouse_id` FK, `organization_id` FK not
  null, `city_key` nullable, `created_by_user_id`, timestamps). A rule is
  "organization X" (`city_key` null) or "organization X in city Y". One rule
  per (organization) and per (organization, city), by two partial unique
  indexes (`... WHERE city_key IS NULL` / `IS NOT NULL`), so a branch can never
  match two warehouses at the same precedence. `city_key` is written only
  through `branchCityKeySql`, never computed in the browser — the same
  expression and index as the city reach (`lib/server/branch-city-key.ts`;
  `lib/warehouse-access.test.ts` pins every copy).
* `apricart_warehouse_memberships.branch_scope` (`ALL` | `SELECTED`, default
  `ALL`), checked; an `EXECUTIVE` row must be `ALL`.
* `apricart_warehouse_member_branches` (`membership_id` FK cascade,
  `branch_id` FK cascade, unique pair) — the selection for a `SELECTED`
  operator.

No change to `branch_fulfillment_routes` (manual assignments only) and none to
`orders`.

**A branch's warehouse** — one SQL expression, `branchWarehouseSql`
(`lib/server/branch-warehouse.ts`), the only place it is decided, with the
precedence **manual route > organization + city rule > organization rule >
none**; its pure twin `resolveBranchWarehouse` (`lib/apricart-warehouses.ts`)
is tested against it. Nothing writes the result anywhere, so:

* a branch created by any path (`createBranchInTx`, `sync-ke.ts`, the CSV and
  workbook imports, the KE repair scripts) is in its warehouse the moment its
  organization and city match a rule — exactly as the city reach today;
* a city edit (Head Office, Super Admin or a script) moves the branch with no
  extra write — the same accepted effect the city reach has today;
* `attachNewBranchToCityWarehouses` keeps running until 2d and is then removed.

**An order's warehouse** — `orders.fulfillment_warehouse_id` if Super Admin
transferred it, else its branch's warehouse now. Creation is unchanged: no
stamp, no backfill.

**Membership scope** — `PUT /api/v1/apricart-warehouses/[id]/members/[userId]/scope`,
Super Admin only, `{ scope: "ALL" } | { scope: "SELECTED", branchIds }`
(strict; ≤ 8 KB, so a large selection is sent per organization like the route
write). Every `branchIds` entry must be in this warehouse now (400 otherwise):
**a selection is always a subset of the warehouse's branches**, and a branch
that later leaves the warehouse simply stops matching. Audited
`UPDATE_APRICART_WAREHOUSE_MEMBER_SCOPE`.

**Rules** — `PUT /api/v1/apricart-warehouses/[id]/rules`, Super Admin only,
`{ organizationId, city | null, assigned }`, one rule per request (no bulk
form: rules are few, and the production mapping is written by the script),
under `FOR UPDATE` on both the target warehouse and the one that held the rule,
in id order; audited `UPDATE_WAREHOUSE_ROUTE_RULES` with `movedFromWarehouseId`.
The city may be any spelling: the key is computed in SQL. The dialog says which
warehouse holds a rule before it is moved; moved orders follow their branch
with no transfer row, as today when a city assignment changes. A transferred
order stays where Super Admin put it. Deactivating a warehouse is refused while
it holds rules, as it already was for manual routes.

**Strand guard** — while membership decides (either membership mode), a rule,
membership or scope change is refused (409) if it raises the number of active
branches in a warehouse that no active operator of it works; strands that
existed before do not block an unrelated change. In the "branch" mode nothing
reads membership, so nothing is checked — `check:warehouse-ownership` is the
gate before the switch. This extends phase 3's last-operator guard, which is
unchanged.

**Transferred orders and scope** — an order transferred to a warehouse is
worked by all of its active operators, whatever their scope, exactly as phase 3
built it: its branch may be in another warehouse entirely, so no selection
could include it.

**The one reach rule** — `isOrderInWarehouseOrderReach` /
`warehouseOrderReachCondition` / `loadWarehouseOrderReach` gain the mode
(below) and the scope:

* an order whose warehouse (as above) is W is the work of W's active operators
  whose scope is `ALL`, or `SELECTED` with the order's branch;
* an order with no warehouse (no transfer, branch in no warehouse) is read by
  branch reach in `branch` and `membership-fallback` modes, and by **no
  warehouse account** in `membership` mode — it is on the Unrouted list.

Nothing else may decide it; every caller listed under phase 3 already goes
through it. Work status (`isWarehouseWorkStatus`) is unchanged, so fulfilled
history follows its branch's warehouse as today. In the membership modes the
support queue (`supportBranchReachCondition`), the catalogue fence
(`loadWarehouseCatalogFence`) and the warehouse's dashboard reach switch to the
same source: the branches in the account's warehouses, narrowed by its
selection. Notification recipients and the send-time re-check follow the rule
with no further change.

**Mode** — a code constant, `WAREHOUSE_ORDER_OWNERSHIP` in
`lib/warehouse-ownership-policy.ts` (like `PASSWORD_CHANGE_EMAIL_VERIFICATION`,
deliberately not an environment variable): `"branch"` (today) →
`"membership-fallback"` → `"membership"`. Shipped as `"branch"`.

**Unrouted orders** — Super Admin only: a list on `/warehouse-team`'s
Warehouses section (open orders with no transfer whose branch is in no
warehouse; count plus the first `UNROUTED_ORDER_LIST_LIMIT`). Actions: add a
rule or a manual route for the branch, or transfer the one order. (The Super
Admin dashboard count in the first draft was not built: the list is where the
action is.)

**The ownership check** — `runWarehouseOwnershipCheck`
(`lib/server/warehouse-ownership-check.ts`) runs `loadWarehouseReach` itself for
every active warehouse account in all three modes and compares; it takes its
client, so the same code answers `GET /api/v1/apricart-warehouses/ownership-check`
(Super Admin, on demand, "report" rate limit; the page's "Run check") and
`npm run check:warehouse-ownership` (one `READ ONLY` transaction, rolled back).

**The mapping script** — `migrate:warehouse-city-rules`, above. Beyond the
planner's refusals it refuses two accounts mapped to one warehouse whose reach
differs (an `ALL` operator would gain the other's branches), and its commit
runs the ownership check **inside the writing transaction** and rolls back
unless no account loses or gains a single branch in either membership mode.

**Riders** — riders and depots are attached to a warehouse **user**
(`rider_profiles.warehouse_user_id`, `rider_depots`); their tables are not yet
in production (2026-10-28). Phase 2 leaves that model alone; the
rider-assignment path must check the order through the reach rule above
(added to the contract list). Moving riders and depots onto
`apricart_warehouses` is a separate follow-up plan.

**Executives** — unchanged (decision 2).

#### 2c — Switch

1. Deploy 2b with the mode `"branch"`. Nothing changes for anyone.
2. Run `migrate:warehouse-city-rules` (dry run, review, commit). Still nothing
   changes: the mode is `"branch"`.
3. Run `npm run check:warehouse-ownership` against production. It must report
   **no difference** for `sheikh.murtaza`, `sohail` or any other active
   account. Then deploy `"membership-fallback"`.
4. Re-run the check after deploy and daily for one release. After one release
   with zero differences and zero unrouted open orders, deploy `"membership"`.

Rollback at any point: redeploy the previous mode. Rules and memberships are
inert under `"branch"`, and per-user assignments are still in place until 2d,
so no data is lost in either direction.

#### 2d — Retire per-user branch and city assignments

After one release in `"membership"` mode:

* stop reading `warehouse_assignments`, `warehouse_city_assignments` and
  `warehouse_city_organizations` (`loadWarehouseReach` is deleted; the
  isolation and write sweeps are re-pointed at membership);
* remove the per-account Branches and Cities dialogs from Warehouse Team;
* remove `attachNewBranchToCityWarehouses` (a rule already covers the new
  branch);
* drop the three tables in a **later** release (rule 06: never drop in the
  release that stops using them).

#### Tests

* Pure: `resolveBranchWarehouse` precedence, scope subset rule, strand guard
  planner, the reach rule in all three modes (`lib/apricart-warehouses.test.ts`,
  `lib/order-warehouse-transfer.test.ts`).
* Integration — **parity first**: a fixture shaped like production (one account
  with a city × organizations reach, one with single branches, a branch created
  with no city and given one later, a branch whose city is edited, fulfilled
  history, a transferred order, support threads); after the mapping script, the
  order, branch and thread sets of every account are identical in all three
  modes. Then: `branchWarehouseSql` agrees with `resolveBranchWarehouse`; the
  mode matrix — an `ALL` operator, a `SELECTED` operator with and without the
  branch, an operator of another warehouse, a branch-only account, Super Admin;
  unrouted orders per mode; a rule change moves untransferred open orders and
  leaves transferred ones; each strand-guard refusal; the mapping script's
  refusals, digest, commit and rollback; a rule change racing a stage move.
* The warehouse isolation and write sweeps run in each mode.
* Contract: every reader of the reach rule, `branchWarehouseSql` as the only
  resolver, the rider-assignment path.

### Phase 3 — transfer (built 2026-10-23, without phase 2)

The requirement is to move **one order**, never a branch: an order meant for
Karachi is delivered from Lahore, and every other order at that branch stays
where it is. That needs ownership only on the orders that are moved, so phase
3 was built on its own, as an override that changes nothing for any order
nobody transfers:

* `orders.fulfillment_warehouse_id` (nullable, FK, partial index on
  `(fulfillment_warehouse_id, status)`) — **null on every order until Super
  Admin transfers it**, and null means "worked by whoever serves its branch",
  exactly as before. Nothing stamps it at creation; routes stay configuration.
* The one rule, `isOrderInWarehouseOrderReach` (`lib/order-warehouse-transfer.ts`):
  a transferred order is the work of its warehouse's **active operator
  members** only; any other order is the work of the branch reach. Its SQL
  form is `warehouseOrderReachCondition` (`lib/server/warehouse-order-reach.ts`),
  and the per-account input is `loadWarehouseOrderReach` (branch reach +
  `loadWarehouseMemberships`). Every order-specific warehouse read and write
  (finding 2) goes through it: queue, picking sheet, invoice, challans, intake
  screenshot, upload, progress, challan-add, workload, timeline, notice
  recipients, the send-time re-check and the notice list. Support and the
  catalogue fence stay on branch reach (finding 3).
* `transferOrderWarehouse` (`lib/server/order-warehouse-transfer.ts`), behind
  `GET`/`POST /api/v1/orders/[id]/fulfillment-warehouse`, Super Admin only.
  Body `{ targetWarehouseId | null, expectedWarehouseId | null, reason }`
  (strict). Null hands the order back to the branch's accounts. Order `FOR
  UPDATE`; target warehouse `FOR SHARE`, must be `ACTIVE` with at least one
  active operator (409); handing back needs an account serving the branch
  (409). Allowed while `PENDING`, or `APPROVED` at `NOT_STARTED`/`IN_PROCESS`
  (`orderWarehouseTransferRefusal`); never once out for delivery or terminal.
  `expectedWarehouseId` must match the row (409 stale). Status, stage,
  `approved_at`, invoice, budget and `updated_at` are untouched — the last so
  an executive approving a pending desk order (`expectedUpdatedAt`) is not
  refused by a transfer that changed nothing it approved.
* In the same transaction: an `order_warehouse_transfers` row, the
  `ORDER_WAREHOUSE_TRANSFERRED` audit row (from/to, reason, TID), and notices
  `WAREHOUSE_ORDER_TRANSFERRED_OUT` to the accounts that lost the order and
  `WAREHOUSE_ORDER_TRANSFERRED_IN` to the ones that gained it (anyone in both
  is told nothing). Both are recurring, keyed on the transfer id.
* Races: every warehouse write guard (`isOrderInWarehouseReach`, `lock`) takes
  the order row `FOR UPDATE` and the reach rows `FOR SHARE`, so a stage move
  and a transfer of one order have one winner. Removing a warehouse's last
  active operator, or deactivating it, is refused (409) while it holds an open
  (pending or approved) transferred order; both take the warehouse `FOR
  UPDATE`, which a transfer onto it waits on.
* Decision 2 is not needed: executives are not involved, and who approves a
  desk order is unchanged. Decision 1 is not needed: only transferred orders
  read membership, and only the target's. Decision 3 is not needed: an order
  with no warehouse is read by branch reach.
* UI: a "Fulfilment warehouse" card on Super Admin's order page
  (`components/orders/order-warehouse-panel.tsx`) shows the current warehouse
  or "served by the branch's warehouse accounts", the branch's default route
  for information, who works it now, the transfer history, and a Transfer
  dialog. The warehouse's picking sheet says when an order was transferred to it.
* Migration `20261101120000_order_warehouse_transfers` (FK added `NOT VALID`,
  then validated). Tests: `lib/order-warehouse-transfer.test.ts`,
  `tests/integration/order-warehouse-transfer.test.ts` (role matrix, refusals,
  both sides' queues/sheets/progress/workload, notices, strand guards,
  hand-back); the warehouse isolation and write sweeps call the new handlers.

Originally planned as:

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
3. Decisions 1–5 taken 2026-10-27/28; phase 2 follows its own 2a → 2d order
   above, rolled out as below.

Phase 2 rollout (production). Each step changes nothing anyone sees until
step 5, and each has its own undo:

1. **Migration.** `npm run db:migrate:prod` (dry run, then `-- --confirm=<digest>`).
   It applies every pending migration in the journal, not only
   `20261104120000`: on 2026-10-28 production was also missing
   `20261102120000_finance_role` and `20261103120000_organization_price_contract_validity`
   (whose code ships in the same deploy), and three rider migrations older than
   its newest, which the runner skips — check the printed list before
   confirming. Additive; undo with the statements in the migration's header.
2. **Deploy** with `WAREHOUSE_ORDER_OWNERSHIP = "branch"`. Undo: redeploy.
3. **Map the accounts.** With `DATABASE_URL` set to production in the shell
   (the script prints the host first):
   `npm run migrate:warehouse-city-rules -- --map=sheikh.murtaza=KARACHI-001 --map=sohail=LAHORE-001`,
   review the dry run, then repeat with `--commit --confirm-plan-sha256=<digest> --operator=<you>`.
   The commit rolls itself back unless both accounts keep exactly their
   branches. Undo: `-- --rollback=<committed report> --confirm-rollback=<printed>`.
4. **Check.** `npm run check:warehouse-ownership` must exit 0 (no change in
   `membership-fallback`); the same report is "Run check" on Warehouse Team.
5. **Switch** to `"membership-fallback"` (a reviewed one-line deploy). Undo:
   redeploy `"branch"`; per-user assignments are still in place.
6. **Then**, after one release with no difference and no open order in no
   warehouse (`-- --target=membership` exits 0): `"membership"`, and 2d a
   release later.

Phase 3 rollout: apply `20261101120000` (`npm run db:migrate:prod`), then
deploy. Add at least one active operator to a warehouse before moving orders
onto it. Rollback: transfer every open order back (`targetWarehouseId: null`),
redeploy the previous code, then drop `order_warehouse_transfers` and
`orders.fulfillment_warehouse_id` (statements in the migration header).

Rollback: hide the section by redeploying the previous code; then
`DROP TABLE branch_fulfillment_routes, apricart_warehouse_memberships,
apricart_warehouses;` — nothing else references them.
