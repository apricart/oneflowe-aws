# OF-BUDGET-BURN — branch-vs-branch peers, and an item-wise MoM drill-down

Refines two signals shipped in `plans/OF-BUDGET-BURN-watchlist.md` (Wave A).
Both are client-requested changes to the "Users to review" watchlist; neither
touches who may see the panel (`BUDGET_BURN_ROLES` stays `SUPER_ADMIN` and
`HEAD_OFFICE`) or adds a write path.

## Change 1 — "Above peers" compares branches, not colleagues

**Before:** a requester's own consumption this month was compared against the
*median consumption of the other active requesters at the same branch*.
`peersMinCount` (2) other active colleagues were required or the figure was
`null`.

**After:** the comparison moves one level up. Each branch's **budget
utilization** (`consumedCents / totalBudgetCents × 100`) this month is
compared against the *median utilization of the other branches in scope*
(their `totalBudgetCents` and `consumedCents` come from the same aggregate
`buildWatchlist` already has — no new query). A branch needs a budget row to
have a utilization at all; a branch with `totalBudgetCents = 0` has no figure
to compare, same as before.

Raw money was rejected as the comparison basis (client-approved decision):
branches differ hugely in budget size, so a raw-total comparison would flag
every large branch and never a small one. Utilization percentage is
comparable regardless of size.

**Consequence, stated plainly because it is a real behaviour change:** since
the branch's own utilization does not depend on which requester is being
scored, `above_peers` is now identical for every requester listed at the same
branch — it says "this branch's spend against its own budget is unusual
relative to other branches," not "this person is unusual relative to their
colleagues." A branch with only one requester can now be flagged for
`above_peers` (it could not be before) — the sole-requester exemption survives
only for `high_share`, which is unchanged and still about one person's share
of their own branch.

### `lib/budget-burn-risk.ts`

- `scoreRequester`'s `peers: readonly CreatorMonth[]` parameter becomes
  `peerBranches: readonly BranchMonth[]` — every other branch in scope this
  month, never including the row's own branch.
- New pure helpers:
  - `branchUtilizationPct(branch): number | null` — `null` when
    `totalBudgetCents <= 0`.
  - `peerBranchMedianUtilizationPct(peerBranches, thresholds)` — replaces
    `peerMedianCents`; same median-not-mean logic, over utilization
    percentages instead of cents, gated on the same guard count.
- `WatchlistMetrics.peerMedianCents` (cents) is replaced by
  `branchUtilizationPct: number | null` (this branch's own figure) and
  `peerBranchMedianUtilizationPct: number | null` (the comparison figure).
  `vsPeerPct` keeps its name and meaning — "how far above the peer figure" —
  just computed from the two new percentages.
- `BUDGET_BURN_THRESHOLDS.peersMinCount` → renamed `branchPeersMinCount`,
  same default (2), comment updated to "other branches with a computable
  utilization." `abovePeersPct` (50%) is unchanged.
- `buildWatchlist` precomputes each branch's peer list once
  (`allBranches.filter(b => b.branchId !== branchId)`) rather than per row, and
  passes it to every row scored at that branch.

### UI (`components/reports/executive/budget-burn-watchlist.tsx`)

- `reasonExplanation("above_peers", …)` copy changes from "the median of the
  other active requesters at the same branch" to "the median budget
  utilization of the other branches in scope."
- The `vs peers` column's tooltip changes from "Fewer than N other active
  requesters at this branch" / "Peer median: ₨…" to "Fewer than N other
  branches with a budget to compare against" / "This branch: X% of budget ·
  peer branch median: Y%."

### Tests

- `lib/budget-burn-risk.test.ts`: replaces the "peer median" /
  `above_peers` describe blocks with branch-level equivalents; the composite
  "every reason" test gets a `branch` override so its utilization still
  crosses the (now branch-level) line; the `buildWatchlist`-level "compares
  peers within a branch only" test is replaced with one proving `above_peers`
  is shared by every row at a heavily-utilized branch and absent at quiet
  ones.
- `components/reports/executive/budget-burn-watchlist.test.tsx`: mock metrics
  fixture renamed field, `reasonExplanation`/tooltip text assertions updated.
- `tests/integration/budget-burn-api.test.ts`: the existing
  `peerMedianCents`/`vsPeerPct` assertions for Ahmed at North stay `null` —
  the fixture only has two branches in scope (North, South), one short of
  `branchPeersMinCount` — just the field name changes.

## Change 2 — clicking a MoM figure opens an item-wise comparison

**What it does:** clicking the MoM % cell for a row opens a second panel:
every product the requester ordered in the current or prior window (the same
two windows already computed for the row's MoM %), quantity and spend on each
side, so "they bought 10 last month, more this month" is a table instead of a
single percentage. Clicking a requester's *name* is unchanged — it still opens
the existing order-lines drill-down.

### New pure module — `lib/budget-burn-item-comparison.ts`

No database, no session; unit-tested on its own.

```ts
export const BUDGET_BURN_ITEM_ROW_CAP = 500

export type ProductWindowRow = {
  productId: number | null; productName: string; unit: string
  quantity: number; valueCents: number; orderCount: number
}

export type ItemComparisonRow = {
  productId: number | null; productName: string; unit: string
  currentQuantity: number; priorQuantity: number; deltaQuantity: number
  deltaPct: number | null   // lib/executive-analytics.growthPct; null with no prior baseline
  currentSpendCents: number; priorSpendCents: number
  currentOrderCount: number; priorOrderCount: number
}

export function buildItemComparison(
  current: readonly ProductWindowRow[],
  prior: readonly ProductWindowRow[],
): ItemComparisonRow[]
```

Rows are keyed on `(productId, unit)` — never summed across units, per the
Center's rule. A product bought in only one window still gets a row (zero on
the other side), because "this is new this month" / "they stopped buying
this" is exactly the deviation the client asked to see. Sorted by
`|deltaQuantity|` descending, so the biggest swings lead.

### New query — `lib/server/budget-burn-item-queries.ts`

Line grain, fenced through the existing `lineConditions(scope, filters)` —
the same fence every Product Performance panel uses, so no new tenant logic
is written. Reuses `lineNetValue` / `lineNetQuantity` (refund-aware) from
`lib/server/executive-analytics-queries.ts` rather than restating the netting.

```ts
export async function loadProductWindow(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,  // startDate/endDate = one window; userIds = [userId]; statusSet: "consumed"
): Promise<ProductWindowRow[]>
```

Grouped by `(orderItems.globalProductId, orderItems.unit)`, labelled from
`MIN(orderItems.productName)` (the line's own snapshot, avoiding a join),
bounded by `BUDGET_BURN_ITEM_ROW_CAP`, ordered by value descending so a
truncation drops the smallest lines. Called twice by the route — once per
window — mirroring how `loadCreatorMonth` is already called twice for the
current and prior creator aggregates.

`statusSet: "consumed"` (the same `CONSUMED_ELIGIBLE_FILTER` the row's MoM
figure is built from) so the item table's totals reconcile with the MoM %
that was clicked, rather than silently dropping pending orders.

### New route — `GET /api/v1/analytics/executive/budget-burn/item-comparison`

Order: rate limit (`search`) → session → `resolveExecutiveScope(session,
url.searchParams)` (so a `branchIds` query param narrows the fence exactly as
every sibling executive route does) → `isBudgetBurnRole(scope.role)` → **scope
must resolve to exactly one branch** (`scope.branchIds?.length === 1`, else
400 — this route answers one requester at one branch, and an unnarrowed
Head Office scope would otherwise silently mix branches) → Zod-validate
`userId` (required, matches the row that was clicked) and optional `month` →
`monthWindows(month, now)` (the same calendar rule the watchlist uses, so the
two windows are the ones the MoM % was computed from) → two `loadProductWindow`
calls → `buildItemComparison` → respond. Errors through
`handleError(error, "EXECUTIVE_BUDGET_BURN_ITEM_COMPARISON")`.

`userId` is read from the request (unlike `budget-burn`'s own route, which
takes no id at all) because this route answers "this specific requester" —
exactly the same shape as `drill-down`'s `key` parameter. It is not a
security boundary: the tenant fence already decided which orders exist before
`userId` narrows further, so a foreign id matches nothing.

Response: `{ userId, branchId, month, windows: { current, prior }, items:
ItemComparisonRow[], currentTotalSpendCents, priorTotalSpendCents, truncated
}`. No requester/branch name — the click already has them from the row that
was clicked; the panel is handed them by the UI rather than re-querying.

### UI

- `components/reports/executive/budget-burn-watchlist.tsx`:
  - New exported type `BudgetBurnItemDrillSelection = { userId, branchId,
    requesterName, branchName, month }`.
  - New prop `onDrillItems?: (selection: BudgetBurnItemDrillSelection) =>
    void` and `selectedItemsKey?: string | null` (mirrors `onDrill` /
    `selectedKey`).
  - The MoM `<td>` becomes a `<button>` calling `onDrillItems`; the name
    button (→ order-lines drill-down) is unchanged. `signedPercent` is
    exported for reuse.
- New `components/reports/executive/budget-burn-item-comparison.tsx` —
  `BudgetBurnItemComparisonPanel`: fetches the new endpoint, renders Product /
  Unit / Qty this month / Qty last month / Δ Qty / Δ% / Spend this month /
  Spend last month, loading/empty/error states, a close button. Presentation
  only, same shape as `BudgetBurnDrillNote` + `DrillDownPanel`.
- `app/(portal)/reports/graphical/page.tsx`: new `burnItemsDrill` state,
  independent of the existing `burnDrill` (order-lines) state — both can be
  open at once, each closes on its own.

### Security

- Same role gate as the rest of the watchlist (`isBudgetBurnRole`, after
  `resolveExecutiveScope`) — no new role is admitted.
- Tenant isolation: `lineConditions(scope, filters)` — identical fence to
  every Product Performance read. The one-branch requirement is a
  correctness check (this route answers one branch), not an isolation
  control; `resolveExecutiveScope` has already intersected whatever
  `branchIds` was requested with the caller's own fence before that check
  runs.
- `userId` and `month` are the only new inputs, Zod-validated; `userId` is
  bounded in length and reaches SQL only as a parameter.
- Bounding: `BUDGET_BURN_ITEM_ROW_CAP` (500) per window; two grouped reads.
- Rate limited (`search` bucket), consistent with every other listing route.
- No email, no price beyond what every executive role already reads.

### Tests

- `lib/budget-burn-item-comparison.test.ts`: merges matching `(product,
  unit)` rows; a product-only-in-current and product-only-in-prior each get a
  zero-filled row; two units of the same product stay separate rows; `deltaPct`
  is `null` with no prior baseline; sort order (`|delta|` desc, ties by
  current quantity).
- `lib/server/budget-burn-item-queries.test.ts`: contract test (source-read,
  matching `lib/server/budget-burn-queries.test.ts`'s style) — server-only,
  fenced through `lineConditions`, grouped by product **and** unit, reuses
  `lineNetValue`/`lineNetQuantity`, bounded by the row cap; route contract —
  order of checks (rate limit → scope → role → single-branch check → Zod →
  load), `handleError` on failure, never a raw message.
- `components/reports/executive/budget-burn-item-comparison.test.tsx`:
  loading/empty/error states, table renders deltas and totals, close button.
- `components/reports/executive/budget-burn-watchlist.test.tsx`: MoM cell is
  a button and calls `onDrillItems` with the right selection; name click still
  calls `onDrill`, unaffected.
- `tests/integration/budget-burn-api.test.ts`: reuses the file's own fixture
  (no new rows) — Ahmed at North, month `2026-08`. From the existing oracle
  (`X2` 800 000 FULFILLED Aug 5, `X3` 1 400 000 FULFILLED Aug 28, `O6`
  PENDING 50 000 Paper ×100 Aug 12, all Paper/Ream) the current window nets
  to one row: Paper, quantity 102 (1 + 1 + 100), value 2 250 000 — exactly
  the row's already-asserted `consumedCents`. The prior window (`X1` 600 000
  Jul 20, `O3` net 4 Ream / 2 000 Jul 5) nets to Paper, quantity 5, value
  602 000 — exactly the row's already-asserted `priorConsumedCents`. This
  reconciles the new endpoint against numbers the existing suite already
  proved correct, rather than hand-deriving a second oracle. Plus: 401, 403,
  a `branchIds` resolving to more than one branch → 400, a foreign `userId` →
  empty `items`.
- `tests/integration/executive-analytics-api.test.ts`: `item-comparison`
  (called with `f.ahmedId` / `f.northBranchId`) joins `everyRoute` for the
  shared 401/403/stale-claim/200/GROUP_USER access-control checks.

## Rollout

Both changes are read-only refinements to an already-shipped, read-only panel.
No schema change, no migration. Rollback is reverting the commit.

## Gates

`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`; report
whether `npm run test:integration` ran or skipped (no `TEST_DATABASE_URL`
locally skips it silently — see `tests/README.md`).
