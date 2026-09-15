# OF-KE — Mirror the legacy per-location catalogue into branch inventory, and make branch budgets follow legacy

## Problem

A K-Electric `ORDER_PORTAL` user at HSEQ & Quality control (branch 179, legacy
location 80) sees one product in `/shop` and cannot place an order: the budget
header reads "PKR 0.00 of PKR 64,995.00".

Verified read-only on production and against the legacy platform (2026-09-14):

### Catalogue

- The shop lists `branch_inventory` rows that are visible **and** active, whose
  `organization_inventory` row is active, whose `global_products` row is active,
  and — because `POST /api/v1/orders` checks and decrements it — whose
  `stock_quantity` covers the requested quantity.
- Legacy stores **one item row per product per location**: 11,475 rows are
  ~142 products across 136 locations, the location reached through
  `Item.CategoryID -> Category.LocationID`. Distribution-group locations carry
  ~63 items, Enabling-group locations ~120. That per-location list *is* the
  legacy branch assignment, and it is what the user expects to see.
- `sync:ke` collapses those rows into one `organization_inventory` entry per
  product and stops there. It never writes `branch_inventory`.
- Of the 161 legacy products mapped in `legacy_product_mappings`, **140 are
  dormant**: `organization_inventory.is_active = false`, stock 0, no image, 5
  without a category — and 135 of them are `inactive` at the **global** level
  too, every one stamped `metadata.legacySource = KE_LOGISTICS`. The legacy
  order import created them that way so that historical order lines resolve
  without the product appearing in the shop, and nothing since has promoted
  them. Legacy still sells ~120 of them today. Sixteen of the inactive global
  products are also referenced by `K-E-Demo` (14) and `UBL` (2) organization
  rows, none of which has a visible branch row.
- The legacy order import also wrote 1,509 `branch_inventory` rows — hidden and
  inactive — for every (branch, product) pair seen in historical orders. The
  Head Office "assign to branch" flow treats any existing non-deleted row as
  "already assigned" and skips it, so those dormant rows cannot be surfaced
  through the UI without a per-row visibility toggle.
- Across the 136 pinned branches: 11,450 legacy (location, product) pairs, of
  which 374 are fully visible in OneFlowe, 9,567 have no branch row, 1,509 have
  a hidden row, and 10,221 point at a dormant organization catalogue entry.

### Budgets

- Legacy `MonthlyBudget` is the allocation; `TotalBudget` is what is **left**
  of it. For every location with `MonthlyBudget > 0`, legacy `TotalBudget`
  equals our `allocated + credited − spent − held` to the rupee, so the spend
  ledger already mirrors legacy.
- Five locations carry `MonthlyBudget = 0` with `TotalBudget > 0` (HSEQ: 5 left
  of 65,000). `ke-budgets.ts` skips those as `NO_BUDGET`, and
  `backfill-ke-budget-spend.ts` then created their month row at the minimum the
  invariant allows, `allocated = spent + held` — which is why HSEQ shows
  "0.00 of 64,995.00" instead of "5.00 of 65,000.00".
- Five more locations have `MonthlyBudget > 0` but a lower allocation in
  OneFlowe (two at 0, three created at the backfill minimum). Today the planner
  reports these as drift and never touches them.
- Two branches carry an allocation legacy does not (`MEGA CENTER` 35,000 and
  the `society cluster` twin 34,675 — the latter an artefact of the order-branch
  repair moving its spend to `Society Cluster`). Nothing is spent or held on
  either.

## Change

The user's instruction: the branch's product list and budget in OneFlowe should
be what the legacy platform has. Both are reference data, so both belong in
`sync:ke`, which is already the idempotent, dry-run, digest-gated mirror of the
legacy platform — not a new one-off script.

### 1. `lib/legacy-import/ke-branch-catalogue.ts` (new, pure)

`planBranchCatalogue(items, categories, branchByLegacyId, catalogue,
assignments, { activatedStock })` returns:

- `globalActivations` — global products parked `inactive` that legacy still
  sells, **only** when the KE import created them (`legacyOwned`:
  `metadata.legacySource = KE_LOGISTICS` or a `KE-` product code). A global
  product has reach beyond this tenant, so one retired by any other hand is
  left alone and its pairs are skipped as `PRODUCT_RETIRED`. Activating a
  global product does not by itself surface it in another tenant — that still
  needs their own organization and branch rows, which the sync never touches;
  the dry run lists any tenant that references one so the reach is visible.
- `activations` — organization catalogue entries legacy sells at ≥ 1 location
  that are inactive in OneFlowe. Applied as `organization_inventory.is_active =
  true` plus an `organization_products` row enabled (the same pair the sync
  writes on create).
- `stockChanges` — products legacy sells whose `stock_quantity` is not what it
  should be. Legacy does not track stock (`isInventoryItem: false`,
  `CurrentStockLevel: null`) but OneFlowe refuses an order that exceeds it, so
  a zero-stock product is unorderable however visible it is. Every product
  legacy sells should hold `--stock` units (default 500, per the requirement
  of 2026-09-14). On an ordinary run only a zero-stock product is set;
  `--reset-stock` sets every one, which is how the 500 is applied to the 16
  products already carrying other figures. Each write is pinned to the stock
  the plan saw, so an order placed meanwhile makes the statement refuse rather
  than overwrite.
- `assignments` — one per legacy (location, product) pair whose branch is
  pinned and whose product is mapped, where no visible+active row exists.
  `CREATE` when there is no row, `RESTORE` when a row exists but is hidden,
  inactive or soft-deleted. Applied as one upsert on
  `branch_inventory_branch_org_inventory_uq`.
- `extras` — rows visible in OneFlowe that legacy does not list at that
  location. **Reported, never hidden**: the sync does not deactivate anything.
- `skipped` — `LOCATION_NOT_PINNED`, `PRODUCT_NOT_MAPPED`, `PRODUCT_RETIRED`
  (global product not active), `NO_LOCATION` (item whose category has none).
- `unchanged` — pairs already correct.

Products the same run creates are not in `catalogue` yet, so their
assignments land on the next run — the same two-pass rule branches and people
already follow.

### 2. `lib/legacy-import/ke-budgets.ts`

- `LegacyLocationBudget` gains `TotalBudget`; `CurrentBudget` gains
  `amountCreditedCents`, `amountSpentCents`, `amountHeldCents`.
- The legacy allocation for a location is `MonthlyBudget` when positive;
  otherwise, when `TotalBudget` is positive, `TotalBudget + spent + held −
  credited` from our own ledger — i.e. what is left plus what we know was
  used. It converges as the order import converges and can never exceed
  legacy while our used ≤ legacy used.
- A missing row is created (as before). An existing row whose allocation is
  **below** the legacy figure is raised (`raises`); this is always safe under
  `budgets_values_valid_ck`. One **above** it is lowered only when
  `allowLower` is set *and* the invariant still holds after the change
  (`lowers`); otherwise it is reported as `drift` with a reason
  (`LOWER_NOT_REQUESTED` / `LOWER_WOULD_BREAK_INVARIANT`). This replaces the
  earlier "never rewrite" rule, on the user's explicit instruction that legacy
  is the source of truth for allocations.
- A location legacy leaves at 0/0 gets no row of its own (the shop creates one
  at zero on demand), but a row we already hold for it is compared like any
  other — so `MEGA CENTER` (35,000, nothing used) and the `society cluster`
  twin (34,675, nothing used) surface as drift, and lower to 0 with the flag.
  A fully spent row whose location reads 0/0 stays where it is, because
  `0 + used` is exactly its allocation.

### 2b. `planZeroBudgets` — the requirement of 2026-09-14

"This month's budget should be zero for each branch." Implemented as a second
budget mode rather than a change to the legacy one, because the two are
different policies and the operator should choose one per run:

- `planZeroBudgets(period, branches, currentBudgets)` reaches **every active
  branch of the organization** (legacy counterpart or not). A missing row is
  created at 0; an existing one is lowered to the floor
  `budgets_values_valid_ck` allows, `spent + held − credited`, so remaining
  is exactly 0 — a branch that has used nothing goes to 0 outright, KE HOUSE
  (899,994 spent) goes to 899,994. Rows already at the floor are unchanged.
- It also clears `branches.baseline_budget_cents` on the 53 branches that
  carry one. Two paths in `app/api/v1/budgets/route.ts` re-fund from the
  baseline — `loadSingleBranchBudget` creates a missing month row at it, and
  `syncCurrentMoneyBudgets` treats an existing zero row with no spend as
  stale and resets it — so without this the Head Office budgets page would
  silently re-fund those branches on its next load. The before values are in
  the report.
- Legacy figures are ignored for the run. The next run must again say which
  mode it wants: the default `legacy` would raise a zeroed month straight back
  to the legacy allocation.

### 3. `scripts/sync-ke.ts`

- Reads the catalogue state (`legacy_product_mappings` ⋈ `organization_inventory`
  ⋈ `global_products`) and every `branch_inventory` row of the organization;
  reads the four budget amounts instead of one.
- Plans the branch catalogue whenever products are planned; prints it under a
  `BRANCH CATALOGUE` heading; folds activations, stock grants, assignments,
  budget raises and lowers into the commit digest so a plan that moved between
  dry run and commit is refused.
- New options: `--budgets=legacy|zero|skip` (default `legacy`),
  `--zero-period=YYYY-MM` (current month unless given), `--stock=<units>`
  (default 500), `--reset-stock`, and `--lower-budgets` (off by default). All
  are part of the digest through the plan they shape.
- Applies, inside the same transaction and after the catalogue creates:
  activations → stock grants → assignments; budgets apply raises/lowers with an
  optimistic `where amount_allocated_cents = <planned current>` guard. After a
  commit that changed budgets the `budgets`/`analytics`/`branches` cache
  prefixes are cleared through `lib/cache-cli.ts`, as the spend backfill does.
  Inventory listing cache TTL is 5 s, so no invalidation is needed there.
- Nothing is deactivated, hidden, deleted or repriced.

### 4. `CLAUDE.md`

Two bullets under the K-Electric legacy sync section: the per-location item
list is the branch assignment and the sync now mirrors it (never hides); and
legacy budgets are now authoritative, with the `TotalBudget + used` fallback.

## Tests

- `lib/legacy-import/ke-branch-catalogue.test.ts`: create vs restore vs
  unchanged; activation only for inactive entries; stock only for zero;
  extras reported not planned; each skip reason; idempotent against its own
  result; a retired product is never assigned; an item with StatusID ≠ 1 is
  not sold.
- `lib/legacy-import/ke-budgets.test.ts`: existing cases updated for the new
  `CurrentBudget` shape; raise; `TotalBudget` fallback with and without a
  current row; lower refused without the flag; lower refused when it would
  break the invariant; lower applied with the flag; idempotence.
- `npm test`, `npm run typecheck`, `npm run lint`.

## Security and data impact

- No endpoint changes. The script requires an active `SUPER_ADMIN` actor, the
  organization confirmation and the plan digest, exactly as today.
- Tenancy is pinned by `organization_id = target.id` on every statement, and
  branches by `external_id`; organization 2 (`K-E-Demo`) cannot be reached.
- Writes: `organization_inventory.is_active`, `organization_products`
  (upsert), `global_products.stock_quantity` (zero → default only),
  `branch_inventory` (upsert visible+active), `budgets.amount_allocated_cents`
  (raise; lower only with the flag). No price column is written. Everything
  runs in one transaction under the existing advisory lock, recorded in
  `legacy_import_batches`.
- Production dry run (2026-09-14): activate 118 products globally and 119 in
  the organization, grant stock to 125, create 9,567 branch rows and restore
  1,509 hidden ones across all 136 branches, raise 10 budgets (net +41,208),
  report 74 extras (hand-assigned batteries, dish liquid, tissues), and — with
  `--lower-budgets` — lower 2 rows to 0.

## Production dry run — zero mode (2026-09-14)

`npm run sync:ke -- --budgets=zero --reset-stock`: 55 rows created at 0, 64
lowered (34 to 0, 30 to their spent+held floor; PKR 4,494,338 of remaining
allocation released), 18 already at the floor, 53 baselines cleared; 141
products set to 500 (16 of them from a non-zero figure); catalogue and branch
assignment figures as above.

## Rehearsal

Run end to end on the local disposable database (`oneflowe_test`, code
`KETEST`, `--create-organization`): pass 1 created the tenant, 136 branches,
4 groups and 157 products; pass 2 created 74 budgets, granted stock to 141
products and wrote all 11,450 branch rows (128 s); pass 3 reported nothing to
sync. HSEQ then listed 63 visible, orderable products under the shop's own
predicates, and per-group averages matched legacy (Distribution 64,
Enabling 114, Transmission 119, Generation 119). Hiding 5 rows, soft-deleting
2 and cutting KE HOUSE to 1.00 was planned as 7 restores + 1 raise and
committed; parking 3 products inactive globally and in the organization with
zero stock was planned as 3 + 3 + 3 and committed; each was followed by a
no-op run. For zero mode the tenant was given three baselines and one spent
row (HSEQ 64,995 of 65,000): `--budgets=zero --reset-stock` planned 62 creates,
74 lowers (HSEQ to 64,995, the rest to 0), 3 baseline clears and 141 stock
sets, committed, and the following run was a no-op; every active branch then
had zero remaining and no baseline, and every product legacy sells held 500.

## Rollback

`--rollback-test` applies and rolls back. After a real commit, the batch row
holds the counts; the visibility side is reversible with a single update on
`branch_inventory` rows whose `updated_at` matches the batch, and budgets by
the before values in the written report (`updatedReports/ke-sync-<date>.json`).
