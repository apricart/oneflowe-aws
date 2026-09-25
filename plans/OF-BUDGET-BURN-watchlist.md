# OF-BUDGET-BURN — "Users to review": a budget-burn watchlist

Status: **Wave A implemented 2026-09-20** on `dev` from `b37cb3a`, for
`SUPER_ADMIN` and `HEAD_OFFICE` only (see "Decisions locked"). Waves B and C
not started.

## Objective

Give Head Office, Super Admin and Group User approvers a ranked shortlist of
requesters whose consumption of a **shared branch budget** looks unusual this
month — by share of branch, month-over-month change, distance from peers,
late-month surge and money locked in pending orders — with a click-through to
the order lines behind each figure. Humans decide what to do; the system
proves nothing about intent and blocks nothing.

Non-goals for Wave A: headcount / per-capita fairness, proof of abuse,
soft or hard caps, any write path.

## Verdict from the investigation

**Wave A and B can be built safely.** They are read-only, need no schema
change, derive everything from `orders`, `order_items`, `refunds`, `budgets`
and `users`, and sit entirely inside an authorization boundary that already
exists and is already integration-tested (`resolveExecutiveScope`). Nothing in
the proposal touches the order hold path, the budget ledger or pricing.

Five things in the proposal do not match the code as it stands and need a
decision before implementation. Each has a recommended default below.

### Finding 1 — Branch Admin has no Graphical Reports today

The proposal says "Who sees it: HO / BA / Super Admin — same as Graphical
Reports scope". Those two halves contradict each other:

- `EXECUTIVE_ANALYTICS_ROLES` is `SUPER_ADMIN | HEAD_OFFICE | GROUP_USER`
  (`lib/executive-analytics.ts`). `resolveExecutiveScope` returns **403** for
  `BRANCH_ADMIN`, the sidebar shows no Graphical Reports entry for that role,
  and the integration suite pins the refusal
  (`tests/integration/executive-analytics-api.test.ts`, "refuses BRANCH_ADMIN…").
- Adding `BRANCH_ADMIN` to that list is **not** a one-line change. The
  drill-down route returns unit prices unredacted and says so explicitly,
  because every executive role may read prices; `BRANCH_ADMIN` is a
  price-restricted role (`lib/price-visibility.ts`,
  `hide_prices_for_branch_admin`). Widening the role list would leak prices
  to a role a tenant may have hidden them from, across every executive route.

**Recommendation:** Wave A ships to the three executive roles. Branch Admin
gets the watchlist in Wave B through the surface it already has — the User
Report page (`/reports/user-report`, served by
`app/api/v1/analytics/users/performance/route.ts`, which already fences BA to
`[users.branchId]` and redacts money through `redactAnalyticsPrices`). For BA
the row shows share %, MoM %, vs-peer % and order counts; rupee columns are
redacted when the tenant hides prices, and the drill-down is withheld (it is
an executive route). That is a separate, smaller piece of work with its own
tests.

### Finding 2 — "Consumed = spent + held" does not reconcile with the drill-down

The proposal's suggested default counts consumption the way utilization does:
`spent + held`, i.e. FULFILLED/PARTIAL + PENDING/APPROVED. But the existing
drill-down (`loadDrillDownLines` → `lineConditions`) applies
`REVENUE_ELIGIBLE_FILTER`, which is FULFILLED/APPROVED/PARTIAL — **PENDING is
excluded**. A manager who clicks a row showing ₨450k and sees lines summing to
₨350k will not trust the panel. The codebase's own words: "a drill-down that
did not add up to its own chart would be worse than no drill-down at all".

The gap is exactly PENDING orders. Two honest options:

| | A. Two columns, existing drill-down | B. Extend the drill-down with a status set |
|---|---|---|
| Row shows | **Spend** (Procurement Value, revenue-eligible) and **Pending** as separate figures; share/MoM/peers computed on `spend + pending` | One **Consumed** figure |
| Drill-down | Unchanged; lists revenue-eligible lines = the Spend column exactly; header states "N pending orders totalling X are not listed" | `statuses=consumed` (allowlisted) adds PENDING lines; totals reconcile to Consumed |
| Shared-module change | none | `ExecutiveFilters.statusSet?: "revenue" \| "consumed"` (default `revenue`) read by `orderConditions`/`lineConditions`; one allowlisted query param in `parseDrillDownRequest` |
| Risk | Reader has to hold two numbers | Touches the fence module every executive query uses — default must be proven unchanged by the existing suite |

**Recommendation: A for Wave A.** It reuses the drill-down as-is, keeps the
Center's vocabulary (Procurement Value / Committed), and the Pending column is
itself the "high held" signal. Revisit B in Wave B if reviewers ask for one
number.

### Finding 3 — the Center's "previous period" is not "last month"

`previousWindow(start, end)` returns the equal-length window immediately
before the selection. For a month-to-date window of 1–20 Sep that is
12–31 Aug — the month-end rush of the prior month against the quiet start of
this one, which biases MoM downward and hides exactly the pattern the feature
is looking for. The watchlist needs its own window rule:

- Month in progress (day *d*): compare **1–d this month** against **1–d last
  month** (clamped to the shorter month). Like-for-like, no projection.
- Completed month: whole month against whole month.

Both in Asia/Karachi. `buildAppMonthPeriods` / `getAppMonthParts` and the
`APP_LOCAL_CREATED_AT` bucketing already exist for this; the day-only param
parser in `lib/date-range-params.ts` already resolves `YYYY-MM-DD` in `+05:00`.
Note `defaultExecutiveWindow` uses server-local `setHours(0,0,0,0)` — do not
copy that pattern.

### Finding 4 — the period filter of the Center does not fit a monthly list

The shared filter bar defaults to the last six months and also carries
category, product and requester focus. A six-month window has no "MTD", and a
product focus would turn "share of branch budget" into "share of branch spend
on toner", which is a different (line-grain) question.

**Recommendation:** the panel takes a **month** (`month=YYYY-MM`, default the
current Karachi month) and honours only the *scope* filters — organization,
group, branch — which are enforced server-side anyway. Category, product and
requester focus are ignored and the panel says so in one line. The response
echoes the exact windows it used so the UI can print them.

### Finding 5 — who counts as a "user" and what is the denominator

`orders.created_by_user_id` can be any of SUPER_ADMIN, HEAD_OFFICE,
BRANCH_ADMIN, ORDER_PORTAL, GROUP_ORDER_PORTAL (`app/api/v1/orders/route.ts`,
`getCreationBranchId`). The User Report filters creators through
`ORDER_CREATOR_ROLES`; the Center's `user` dimension does not filter at all.

**Recommendation:** rows are requesters — `roles.name IN ORDER_CREATOR_ROLES`,
never `= 'ORDER_PORTAL'` (CLAUDE.md: group requesters must not vanish). The
**denominator** for "share of branch" is the branch's *whole* consumption by
every creator, because that is what the shared budget actually lost; the
branch summary carries `otherCreatorsConsumedCents` so the arithmetic is
auditable and the panel can footnote it. A group requester appears once per
branch they ordered for, keyed on `orders.branch_id` (the budget that was
spent), never on `users.branch_id`.

Three more facts that shape the design:

- **Group orders are ordinary rows.** Keying on `(created_by_user_id,
  orders.branch_id)` already attributes a Group Order Portal submission to the
  branch whose budget it spent. No query may add `groupOrderId IS NULL`.
- **Budgets are per branch and per month** (`budgets`, unique on
  `(branch_id, period)`); `users.budget_allocation_enabled` only decides who may
  *allocate*. There is no per-user budget to compare against — the "share of
  branch" framing is the right one.
- **The current attention list lives in the route handler**
  (`buildAttentionList` in `overview/route.ts`), which rule 01 forbids. The new
  scoring must live in `lib/` and be unit-tested; this plan does not move the
  old function.

## Alignment with the ticket description (checked 2026-09-20)

The description's seven signals, four report surfaces and "honest limit" map
onto this plan as follows. Nothing in it reverses a recommendation above.

| Ticket | Here |
|---|---|
| Share / MoM / peers / late surge / held | The five scored signals, Wave A |
| Many orders, high qty, repeated SKUs | `orderCount` is a column in A; **repeat SKU is B5** (line grain); a raw quantity total is not built — the Center refuses to add litres to reams |
| Re-order after reject / cancelled-then-replaced | `rejected_orders` chip in A (REJECTED count only); **the "replaced" match is B5** |
| "vs branch peer avg" | Peer **median**, deliberately — a mean is dragged up by the outlier being scored |
| Watchlist + drill to lines | Wave A, reusing `DrillDownPanel`; Finding 2 governs what the lines reconcile to |
| Branch heat map | B1 |
| Month-end burn monitor (users whose rate exhausts the budget) | B2, branch and user level |
| Branch Admin sees watchlist before approving | Finding 1: B3 (BA surface) then B4 (approval-screen badge) |
| Soft/hard caps, exception reason, audit of oversized baskets | Wave C, constraints recorded below |
| Weekly Head Office review, named owner | Process; the standalone endpoint keeps a weekly digest cheap later |
| "Deliberate is a policy + review conclusion" | Copy requirement; the score is never persisted or enforced in A/B |

## Decisions locked (2026-09-20)

| Decision | Locked as |
|---|---|
| Who sees it | **`SUPER_ADMIN` and `HEAD_OFFICE` only** — `BUDGET_BURN_ROLES` in `lib/budget-burn-risk.ts`, checked after `resolveExecutiveScope`. `GROUP_USER` is admitted to the Center but refused here (integration-tested); adding it is a one-line change plus a test flip, and a product decision. Branch Admin stays Wave B. |
| Primary metric | Spend (revenue-eligible) and Pending as two columns; scoring on their sum. **Finding 2 resolved as option B after the first live look (2026-09-20):** a requester whose whole month was one pending order drilled into an empty table, so the drill-down now takes an allowlisted `statuses=consumed` (`DRILLDOWN_STATUS_SETS`, `CONSUMED_ELIGIBLE_FILTER`) and the watchlist always asks for it — the listing adds up to Spend + Pending, pending lines carry their status, and the note above it says which part is only pending. The default (`revenue`) is unchanged for every chart, pinned by contract test. |
| Statuses | Spend: FULFILLED, PARTIAL, PARTIALLY_FULFILLED, APPROVED. Pending: PENDING. Rejected count: REJECTED only. CANCELLED counts nowhere |
| Period | Calendar month, Asia/Karachi; MTD vs prior month to the same day; whole vs whole once complete |
| MoM rule | ≥ +15 % on a prior of ≥ ₨5,000 |
| Endpoint | Own route, `GET /api/v1/analytics/executive/budget-burn` |
| Caps | None |

### What shipped

- `lib/budget-burn-risk.ts` — roles, thresholds, `monthWindows`, `summarizeCreators`, `scoreRequester`, `buildWatchlist` (36 unit tests).
- `lib/server/budget-burn-queries.ts` — `loadCreatorMonth`, order grain, fenced through `orderConditions` (11 contract tests pin the fence, the grain, the statuses and the route's order of checks).
- `app/api/v1/analytics/executive/budget-burn/route.ts` — rate limit → scope → role → Zod → load → score → respond; `handleError` on failure.
- `components/reports/executive/budget-burn-watchlist.tsx` — the panel, `BudgetBurnDrillNote`, wired into the Overview tab of `app/(portal)/reports/graphical/page.tsx` with the existing `DrillDownPanel` (16 component tests).
- `tests/integration/budget-burn-api.test.ts` — 20 tests against the shared fixtures plus a hand-worked flagged scenario; the route is also in the shared `everyRoute` access-control table.
- Gates on 2026-09-20: `npm test` 2680 passed; `npm run test:integration` 346 passed, ran against `oneflowe_test`; `npm run typecheck` clean; `npm run lint` 0 errors (113 pre-existing warnings in `scripts/`); `npm run build` succeeded (locally with `NEXTAUTH_URL` overridden to an HTTPS value — the local `.env.local` fails the production HTTPS check on every route; CI has no `.env.local`).
- Not yet done from the original steps: **step 8, the dry run on live K-Electric data to tune the thresholds.** The constants are the illustrative ones in this plan until that happens. First live look (September 2026 MTD, 87 requesters): one person flagged at score 5 on a single pending order of ₨34,890 — `mom_spike` + `late_surge` + `high_held`. Worth deciding at tuning: whether `late_surge` should need more than one order in the month (a single month-end order is not a surge, though it is the "use it or lose it" shape), and whether `high_held` should need a floor in rupees even where the branch budget is small.

## Decisions to lock with the client (defaults chosen from the code — superseded above where they differ)

| Decision | Options | Default in this plan |
|---|---|---|
| Primary metric | spend / qty / both | **Consumed = Spend (revenue-eligible) + Pending**, shown as two columns (Finding 2); quantity shown per unit only where a single unit is in scope, otherwise omitted |
| Statuses | pending+held / approved+ / fulfilled only | Spend: FULFILLED, PARTIAL, PARTIALLY_FULFILLED, APPROVED (= `REVENUE_ELIGIBLE_FILTER`). Pending: PENDING. Nothing else counts |
| Period | calendar month vs range | **Calendar month, Asia/Karachi**, MTD when current; MoM against the prior month to the same day (Finding 3) |
| MoM rule | +15% with min baseline | **≥ +15 %** and prior consumed **≥ ₨5,000** (500 000 cents) |
| Who sees it | HO / BA / SA | **SUPER_ADMIN, HEAD_OFFICE, GROUP_USER** (Finding 1); BA in Wave B via User Report |
| Caps in v1 | none / soft / hard | **None.** Wave C, separate plan |
| Where it lives | overview payload vs own endpoint | **Own endpoint** — the overview already runs 12 parallel reads; the panel has its own load state, rate limit and tests, and a future Branch Admin or weekly-email surface can call it |

## Acceptance criteria (Wave A)

1. A Head Office user opens Graphical Reports → Executive Overview and sees a
   "Users to review" panel for the current month, ranked by score, each row
   showing requester, branch, spend MTD, pending, share of branch, MoM %,
   vs peers (median), orders / pending / rejected counts and reason chips.
   Quantity is not a column: totals across units are refused by the Center's
   unit rule, and per-product quantity is the drill-down's job.
2. Every chip corresponds to a named, exported threshold, and the response
   carries those thresholds so the UI can print the exact number behind each.
3. Clicking a row opens the existing drill-down panel narrowed to that
   requester and that branch for the same month; its Value total equals the
   row's Spend column; its header states how many pending orders (and what
   value) are not listed.
4. The panel copy says the list shows unusual consumption patterns for review
   and is not proof of intent.
5. A GROUP_USER sees only requesters at branches it is assigned to; a Head
   Office user of tenant B sees nothing of tenant A; BRANCH_ADMIN, ORDER_PORTAL
   and GROUP_ORDER_PORTAL receive 403; no session 401; a session whose claim
   says HEAD_OFFICE but whose row says BRANCH_ADMIN receives 403.
6. Guards hold: a sole requester at a branch is never flagged for share or
   peers; a month fewer than 14 days old never flags a late surge; a prior
   month below the baseline never flags MoM; a branch with no budget never
   flags high-held by percentage.
7. Empty state renders when nothing scores ≥ 4; the panel never shows more
   than `limit` rows (default 25, max 100).
8. `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` pass; the
   integration suite runs (not skips) and passes against the test database.

## Architecture

| Piece | Layer | File |
|---|---|---|
| Thresholds, windows, scoring, ranking — pure | `lib/` | `lib/budget-burn-risk.ts` + `.test.ts` |
| Aggregates per requester × branch; prior-month aggregate | `lib/server/` | `lib/server/budget-burn-queries.ts` + `.test.ts` (SQL-shape tests where useful) |
| Route: auth → scope → validate → load → score → respond | route | `app/api/v1/analytics/executive/budget-burn/route.ts` |
| Panel + row chips + drill wiring | UI | `components/reports/executive/budget-burn-watchlist.tsx` + `.test.tsx` |
| Page wiring on the Overview tab | UI | `app/(portal)/reports/graphical/page.tsx` |
| Integration tests | tests | `tests/integration/budget-burn-api.test.ts`, reusing `helpers/executive-analytics-fixtures.ts` |

Reused as-is: `resolveExecutiveScope`, `loadScopedBranches`,
`loadBranchBudgets` (branch total / remaining / held for the month),
`growthPct`, `safeDivide`, `withCumulativeShare` (Wave B concentration),
`withRateLimit("search")`, `DrillDownPanel` with a `DrillTarget` of
`{ dimension: "user", key: userId, narrow: { branchIds: [branchId] } }`,
`APP_LOCAL_CREATED_AT` / `buildAppMonthPeriods` for Karachi months,
`ORDER_CREATOR_ROLES`.

### `lib/budget-burn-risk.ts` (pure)

```ts
export const BUDGET_BURN_THRESHOLDS = {
  highSharePct: 40,                  // share of branch consumed
  highShareMinBranchCents: 2_000_000, // ₨20,000 — below this a "share" is noise
  momSpikePct: 15,
  momMinBaselineCents: 500_000,      // ₨5,000 prior month
  abovePeersPct: 50,                 // ≥ 1.5 × peer median
  peersMinCount: 2,                  // other active requesters at the branch
  lateSurgeDays: 7,
  lateSurgePct: 50,                  // share of MTD consumed in the last N days
  lateSurgeMinElapsedDays: 14,       // else "last 7 days" is most of the month
  lateSurgeMinConsumedCents: 500_000,
  highHeldPctOfBudget: 20,           // pending ≥ 20 % of branch total budget
  highHeldFloorCents: 2_500_000,     // ₨25,000, used when the branch has no budget row
  rejectedOrdersMin: 3,              // set after the dry run; nobody knows the base rate yet
  flagScore: 4,
} as const

export const BUDGET_BURN_POINTS = {
  high_share: 3, mom_spike: 2, above_peers: 2, late_surge: 2, high_held: 1,
  rejected_orders: 1,              // ≥ rejectedOrdersMin orders REJECTED by an approver this month
} as const

export type BudgetBurnReason = keyof typeof BUDGET_BURN_POINTS

export type RequesterMonth = {
  userId: string; branchId: number
  spendCents: number; pendingCents: number
  orderCount: number; pendingOrderCount: number
  rejectedOrderCount: number        // status REJECTED only — a self-cancel is not evidence of anything
  recentConsumedCents: number       // consumed in the last lateSurgeDays of the window
  priorConsumedCents: number        // same-days window of the prior month
}

export type BranchMonth = {
  branchId: number
  consumedCents: number             // every creator, every status that counts
  totalBudgetCents: number; remainingCents: number
  activeRequesterCount: number
}

export type WatchlistRow = {
  userId: string; branchId: number
  score: number
  reasons: BudgetBurnReason[]
  metrics: {
    spendCents: number; pendingCents: number; consumedCents: number
    shareOfBranchPct: number
    momPct: number | null           // null = no usable baseline (Finding 3)
    vsPeerPct: number | null        // null = fewer than peersMinCount peers
    peerMedianCents: number | null
    recentSharePct: number | null   // null = too early in the month
    orderCount: number; pendingOrderCount: number; rejectedOrderCount: number
  }
}

export function monthWindows(month: string, now: Date): {
  current: { start: Date; end: Date; complete: boolean; elapsedDays: number }
  prior:   { start: Date; end: Date }
  recent:  { start: Date; end: Date }
}
export function peerMedianCents(rows: RequesterMonth[], self: RequesterMonth): number | null
export function scoreRequester(row: RequesterMonth, branch: BranchMonth, peers: RequesterMonth[], elapsedDays: number, t = BUDGET_BURN_THRESHOLDS): WatchlistRow
export function buildWatchlist(rows: RequesterMonth[], branches: BranchMonth[], elapsedDays: number, limit: number): WatchlistRow[]
```

Ranking: score desc, then `consumedCents` desc, then `userId` for a stable
order. `buildWatchlist` returns flagged rows only (score ≥ `flagScore`); the
route may also return the unflagged remainder count so the panel can say
"32 other requesters below threshold".

`monthWindows` is the only place the calendar is interpreted. `month` is
`YYYY-MM`; the current window starts at `YYYY-MM-01T00:00:00+05:00` and ends at
`min(end of month, now)`; `complete` is whether `now` is past the month end;
`prior` is the previous month clamped to the same elapsed day count; `recent`
is `[current.end − lateSurgeDays, current.end]` clamped to `current.start`.
Tested for February, 31/30-day neighbours, the year boundary, and 00:00–05:00
Karachi on the 1st (the same edge `addonPeriodsOpenAt` handles).

### `lib/server/budget-burn-queries.ts`

One grouped read per window, rooted at `orders`, never joined to
`order_items` (order grain — the money is `total_cents − refund_amount_cents`,
the same expression as `metricExpressions.revenue` and the budget `heldCents`
in `loadBranchBudgets`):

```sql
SELECT o.created_by_user_id, o.branch_id,
       SUM(CASE WHEN UPPER(o.status) IN ('FULFILLED','PARTIAL','PARTIALLY_FULFILLED','APPROVED')
                THEN GREATEST(0, o.total_cents - COALESCE(o.refund_amount_cents,0)) ELSE 0 END) AS spend_cents,
       SUM(CASE WHEN UPPER(o.status) = 'PENDING'
                THEN GREATEST(0, o.total_cents - COALESCE(o.refund_amount_cents,0)) ELSE 0 END) AS pending_cents,
       COUNT(CASE WHEN UPPER(o.status) IN (...revenue...) THEN 1 END) AS order_count,
       COUNT(CASE WHEN UPPER(o.status) = 'PENDING' THEN 1 END) AS pending_order_count,
       COUNT(CASE WHEN UPPER(o.status) = 'REJECTED' THEN 1 END) AS rejected_order_count,
       SUM(CASE WHEN o.created_at >= $recentStart AND UPPER(o.status) IN (...revenue..., 'PENDING')
                THEN GREATEST(0, ...) ELSE 0 END) AS recent_consumed_cents,
       r.name AS role_name, u.full_name, u.employee_id, u.email, u.is_active, u.deleted_at
FROM orders o
JOIN users u ON u.id = o.created_by_user_id
JOIN roles r ON r.id = u.role_id
WHERE <tenantConditions(scope)>            -- orders.branch_id IN fence, orders.organization_id IN tenants
  AND o.created_at BETWEEN $start AND $end
GROUP BY o.created_by_user_id, o.branch_id, r.name, u.full_name, u.employee_id, u.email, u.is_active, u.deleted_at
ORDER BY spend_cents + pending_cents DESC
LIMIT 2000
```

- Written with the drizzle builder, reusing `orderConditions(scope, filters,
  { revenueEligible: false })` from `executive-analytics-queries.ts` for the
  fence and window (`filters` with empty category/product/user/group lists),
  so the fence is byte-identical to every other executive read. Only the two
  role-1:1 joins are added; neither can fan out.
- The **branch denominator** comes from the same result: sum every creator's
  `spend + pending` per branch; requester rows are then the subset with
  `role_name IN ORDER_CREATOR_ROLES`. One read, two uses, no second query
  that could disagree.
- The **prior window** is the same read over `prior` (recent column ignored).
- **Branch budget** for the month: `loadBranchBudgets(scope, { startDate:
  current.start, endDate: current.end, … })` — total, remaining, held, exactly
  as the Overview computes them.
- Indexes: `orders_branch_status_created_idx (branch_id, status, created_at)`
  and `orders_org_created_idx` cover the fence + window. A one-month window
  over one tenant is small (K-Electric: ~150 requesters × ~1 branch).
- `LIMIT 2000` is a safety cap, not a page: peer medians need every requester
  at a branch, and no tenant is near that. If a row set ever hits the cap the
  response says `truncated: true`.

## API

`GET /api/v1/analytics/executive/budget-burn`

Order in the handler (rule 05): `withRateLimit("search", userId)` →
`resolveExecutiveScope(session, searchParams)` (401/403, tenant + branch fence
from the caller's row, `organizationId`/`branchIds`/`groupIds` only ever
narrow) → parse `month` and `limit` with a small Zod schema (unknown keys
outside the scope set are ignored, as the sibling routes do; a malformed
`month` is 400) → load → score in `lib/` → respond. Errors through
`handleError(error, "EXECUTIVE_BUDGET_BURN")`, never a raw message.

Query: `month=YYYY-MM` (default current Karachi month; a month more than 24
months back or in the future is 400), `limit` (1–100, default 25), plus the
scope params the Center already sends.

Response (all money integer cents):

```json
{
  "scope": { "role": "HEAD_OFFICE", "organizationIds": [10], "branchCount": 136 },
  "month": "2026-09",
  "windows": {
    "current": { "startDate": "...", "endDate": "...", "complete": false, "elapsedDays": 20 },
    "prior":   { "startDate": "...", "endDate": "..." },
    "recent":  { "startDate": "...", "endDate": "..." }
  },
  "rows": [{
    "userId": "…", "requesterName": "…", "employeeId": "…", "role": "ORDER_PORTAL",
    "accountStatus": "ACTIVE",
    "branchId": 12, "branchName": "…",
    "score": 7, "reasons": ["high_share", "mom_spike", "late_surge"],
    "metrics": { "spendCents": 0, "pendingCents": 0, "consumedCents": 0,
                 "shareOfBranchPct": 0, "momPct": null, "vsPeerPct": null,
                 "peerMedianCents": null, "recentSharePct": null,
                 "orderCount": 0, "pendingOrderCount": 0, "rejectedOrderCount": 0 }
  }],
  "branches": [{ "branchId": 12, "branchName": "…", "consumedCents": 0,
                 "otherCreatorsConsumedCents": 0, "totalBudgetCents": 0,
                 "remainingCents": 0, "activeRequesterCount": 3 }],
  "unflaggedCount": 32,
  "truncated": false,
  "thresholds": { …BUDGET_BURN_THRESHOLDS }, "points": { …BUDGET_BURN_POINTS }
}
```

Only the fields the panel needs. No email addresses (the User Report returns
them; this panel does not need to). Statuses: 200, 400 (bad month/limit), 401,
403 (role, no tenant, no branches in scope), 429 with `Retry-After`, 500
generic.

Drill-down: no new endpoint. The panel opens `DrillDownPanel` with
`target = { dimension: "user", key: row.userId, label, narrow: { branchIds:
[String(row.branchId)] } }` and `filters` whose `startDate`/`endDate` are the
month window's `YYYY-MM-DD` strings. `branchIds` is intersected with the fence
by `resolveExecutiveScope`, so a forged branch id narrows to nothing.

## Data

No schema change, no migration, no backfill. Nothing is written. Every figure
is recomputed on read from `orders`, `users`, `roles`, `budgets`.

## Security

- **Authentication / authorization:** the existing executive boundary.
  `resolveExecutiveScope` reads role and tenant from the user row, not the
  JWT; refuses everything but the three executive roles; an empty branch set
  is a deny. The new route adds no role and changes no scope rule. Add it to
  the `everyRoute` table in the integration suite so the five access-control
  cases run against it unchanged.
- **Tenant isolation:** the only tenant predicate is `tenantConditions(scope)`
  via `orderConditions`; `loadBranchBudgets` applies its own branch fence. The
  cross-tenant test uses the neighbour Head Office and the South approver from
  the shared fixtures.
- **Input:** `month` and `limit` are the only new inputs, Zod-validated,
  bound as parameters; nothing is interpolated. Sort order is fixed.
- **Bounding:** `limit` ≤ 100 rows out; ≤ 2000 aggregate rows in; a single
  month in; two grouped reads plus the existing budget read.
- **Rate limit:** `search` bucket, as the drill-down and matrix routes.
- **Price visibility:** every admitted role may read prices, so no redaction
  is needed here (`lib/price-visibility.ts` restricts BA and OP only). This is
  the reason Branch Admin waits for its own path (Finding 1).
- **Data sensitivity:** the list names employees with a "score". Copy must
  carry the "not proof of intent" line; the score is not written anywhere and
  is not exported in Wave A. Reads are not audited, consistent with every
  other report read; revisit if the client wants a record of who reviewed
  whom.
- **Caching:** none in Wave A. If added later, key with `executiveCacheKey`
  (resolved scope in the key), never the requested ids.
- **Threats considered:** IDOR via `branchIds` (intersected, not trusted);
  enumeration via 403 vs 404 (the Center returns 403 for out-of-scope
  branches and this route matches it); DoS via wide windows (one month, capped
  rows); role escalation via stale JWT (row is authoritative); leaking
  another role's prices (not admitted).

## Tests

**Unit — `lib/budget-burn-risk.test.ts`** (behavioural, no DB):
- `monthWindows`: current month MTD; completed month; February vs March
  clamping; December → November; year boundary; `now` at 03:00 Karachi on the
  1st still belongs to the new month; `recent` never starts before the month.
- Each signal on and off at its boundary (`≥` vs `<`), each guard: sole
  requester → no `high_share`/`above_peers`; one peer → `vsPeerPct: null`;
  prior below baseline → `momPct` present but no `mom_spike`; prior zero →
  `momPct: null`; elapsed < 14 days → `recentSharePct: null`, no `late_surge`;
  branch total budget 0 → `high_held` by floor only; two REJECTED orders → no
  `rejected_orders`, three → chip; CANCELLED never counts toward it.
- Score arithmetic and `flagScore` cut; ranking and tiebreak; `limit`.
- `peerMedianCents` with even/odd counts, excluding self.

**Integration — `tests/integration/budget-burn-api.test.ts`** using
`createExecutiveAnalyticsFixtures`, `month=2026-08` (a completed month, so no
clock dependence). Hand-worked oracle from the fixture comment:
- North: Ahmed spend 0, pending 50 000 (O6), Group spend 2 000 (O5, APPROVED);
  branch consumed 52 000; Ahmed share 96.2 %, Group 3.8 %; prior month (Jul)
  Ahmed 2 000 (O3 net of refund), Group 0 at North.
- South: Sana spend 1 500 (O8); O7 CANCELLED counts nowhere; prior (Jul) Group
  8 000 (O4) at South.
- Access: 401; 403 for BA/OP/GOP; stale claim; HO and SA 200; neighbour HO
  sees no tenant-A row; South approver sees South rows only; `branchIds` of
  tenant B narrows to 403 "No branches in scope"; bad `month` → 400; `limit`
  clamped.
- Add the route to `everyRoute` in `executive-analytics-api.test.ts`.
- Report whether the suite ran or skipped (`TEST_DATABASE_URL`; local setup in
  `tests/README.md`).

**UI — `components/reports/executive/budget-burn-watchlist.test.tsx`:**
loading, empty state, chips rendered with threshold text from the response,
"not proof of intent" copy present, row click calls `onDrill` with the user ×
branch target, scope-filter note shown.

**Gates:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`,
`npm run test:integration` (check stderr says it ran).

## Risks

- **Misreading the list as an accusation.** Mitigation: copy, chips that name
  the number, guards that suppress trivially-true signals, drill-down to
  evidence. This is the main product risk; the rollout below exists for it.
- **Reconciliation confusion between Spend and Pending.** Mitigation: two
  columns, drill-down header states the pending remainder (Finding 2).
- **Threshold tuning on real data.** Constants are exported and read by the
  UI; the dry-run step below tunes them before anyone relies on the list.
- **Latency.** Two grouped reads over one month plus the budget read, on
  indexed columns; separate endpoint so the Overview is not slowed.
- **Blast radius if wrong:** none on live data — no write path. A wrong figure
  is a wrong report row, fixed by redeploy.
- **Rollback:** remove the panel from the page and the route; nothing to undo
  in the database.

## Steps (each independently verifiable)

1. `lib/budget-burn-risk.ts` + tests — thresholds, `monthWindows`, scoring,
   ranking. `npm test -- budget-burn` green before any SQL is written.
2. `lib/server/budget-burn-queries.ts` — `loadRequesterMonth(scope, window)`
   returning creator × branch rows with role and identity columns; a helper
   that splits requester rows from the branch denominator.
3. Route `app/api/v1/analytics/executive/budget-burn/route.ts` following the
   `standard-api-endpoint` skill; Zod schema for `month`/`limit`.
4. Integration tests (step 2–3) against the shared fixtures; add the route to
   `everyRoute`. Confirm the suite ran.
5. `components/reports/executive/budget-burn-watchlist.tsx` — table, chips,
   month chip, empty/loading/error states, scope-filter note, drill wiring;
   component tests.
6. Wire into the Overview tab beside "Needs attention"; hold `drillTarget`
   state on the page and render `DrillDownPanel` below the grid with the
   month window as its `filters`; drill-down header shows the pending
   remainder for the row.
7. Security check (`standard-security-check`) and self-review
   (`standard-code-review`) on the diff.
8. Dry run on the K-Electric September data through the UI (read-only), tune
   thresholds so the list is tens of rows, not hundreds; record the chosen
   constants in this plan.
9. Gates; PR per rule 07 with testing evidence and the integration-suite
   status.

## Wave B (after Wave A is in use)

- **B1 Branch concentration.** From the same aggregate: top-1 and top-2
  requester share per branch (`withCumulativeShare`); flag top1 ≥ 60 % or
  top2 ≥ 80 % when `activeRequesterCount ≥ 3`. Returned as
  `branchConcentration` on the same endpoint; rendered as a compact card.
- **B2 Month-end runway.** Branch level: `branchDailyBurn =
  branchRecentConsumed / 7`, `daysLeft = remaining / dailyBurn`, flagged when
  `daysLeft < daysRemainingInMonth`. User level, the ticket's framing: the
  same arithmetic at the requester's own recent rate — "at this person's pace
  the branch is empty in N days". Presentation only; pure helpers beside the
  scoring; the `recentConsumedCents` inputs already exist.
- **B3 Branch Admin.** A `budget-burn` block on the User Report, served by a
  BA-capable route that fences to `[users.branchId]`, applies
  `shouldHidePricesForRole` + `redactAnalyticsPrices`, and omits the
  drill-down. Own 401/403/success/cross-branch tests.
- **B4 Requester badge on the approval screen** — the ticket's "Branch Admin
  sees watchlist before approving", without caps. `/orders/[id]` shows the
  requester's current-month chips for the order's branch. Head Office and
  Group User read the executive endpoint; Branch Admin needs B3 first. Still
  read-only; the approver decides.
- **B5 Volume signals** — the two the ticket lists that need order lines:
  - `repeat_sku`: per requester × branch × `order_items.global_product_id`,
    `COUNT(DISTINCT order_id)` in the month; chip when any one product was
    ordered on ≥ N separate orders. Line grain, so a third read (rooted at
    `order_items`, fenced through `lineConditions`); by order count rather than
    quantity, so the unit-of-measure rule never blocks it.
  - `reorder_after_reject`: a REJECTED order followed within 7 days by a new
    order from the same requester at the same branch sharing at least one
    product. Needs `orders.rejected_at` and a bounded self-join on lines within
    the month. Define the matching rule with the client before building —
    "same product" vs "same basket" changes the count a lot.
- ~~B6 drill-down `statuses=consumed`~~ — done in Wave A (see Decisions locked).

## Wave C — controls (not planned here; constraints recorded)

Any cap is a business rule on the hold path and must (a) live in `lib/`,
(b) run **inside the same `FOR UPDATE` transaction** that takes the hold, on
every path `lib/server/budget-addon-expiry.test.ts` pins (orders POST/PATCH,
group order creation), (c) be carried as a `Permission` and an
`organization_settings` key, (d) write an audit row with the score snapshot
and any override reason, and (e) never be enforced from the score alone
without a human-facing reason. Separate plan, separate ticket.

## Effort

Wave A ≈ 4 days (scoring 0.5, queries + route 1, integration tests 0.5,
panel + wiring 1.5, tuning + review 0.5). Wave B1–B2 ≈ 1.5 days; B3 ≈ 1.5
days. Wave C ≥ 2 weeks including product design.
