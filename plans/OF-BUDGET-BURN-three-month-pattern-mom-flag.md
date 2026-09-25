# OF-BUDGET-BURN — three months of consumption, and one month-over-month red flag

Supersedes the *highlight rule* of `plans/OF-BUDGET-BURN-three-month-trend.md`
and narrows the panel shipped by `plans/OF-BUDGET-BURN-watchlist.md` (refined
by `plans/OF-BUDGET-BURN-branch-peers-and-mom-items.md`). Read-only. No schema
change, no new role, no write path, no change to budgets, holds or order
behaviour.

## The ask

> Show each user's (and each product's) consumption for the last three months,
> and highlight in red when this month is 15% or more above the previous month.

The panel stops being a multi-signal risk score and becomes a **pattern plus
one alert**: three month columns for the eye, a single month-over-month
comparison for the red.

## Verdict on the proposal

The proposal is right about the shape and right to build it as a slim of the
existing surface rather than a new report. Six things in it do not match the
code as it stands, and each needs a decision or a correction before Wave 2.

### Finding 1 — the flag window and the item panel are coupled, by rule

`CLAUDE.md` states it as load-bearing: *"The item-wise panel behind a click on
that column reads those same two runs — reading the month on one side would
make the table disagree with the percentage it exists to explain."* Changing
the highlight to month-over-month therefore **forces** a change to
`item-comparison`; it cannot be left on the 3-vs-3 windows. The proposal's
"Item view = three month columns + MoM on latest vs prior" is the correct
resolution, but it is not optional polish — it is the same change, and it
costs a third `loadProductWindow` call per click.

### Finding 2 — "Metric: Spend" would make the table contradict its own red

The proposal defaults the metric to Spend. The existing figure being replaced
compares **Consumed** (Spend + Pending), the drill-down behind a row asks for
`statuses=consumed`, and the budget ledger's "spent + held" is Consumed. Today
this is already visible on `dev`: the top row of the September 2026 list shows
**Spend ₨0, Pending ₨371,175, +136%** — a month column reading ₨0 beside a red
+136% is exactly the confusion this rework exists to remove.

**Recommended default: the three month columns are Consumed**, with the
current month's cell carrying "incl. ₨X pending" where pending is non-zero, and
the MoM comparing Consumed on both sides. Then the columns, the percentage and
the drill-down all reconcile.

### Finding 3 — listing everyone is a different panel, and it truncates

`buildWatchlist` today returns only rows scoring ≥ `flagScore` (4) — seven rows
in the screenshot, with 126 below the line. "Show each user's consumption"
means the list is no longer a shortlist. Consequences the proposal does not
cost:

- `BUDGET_BURN_DEFAULT_ROWS` is 25 and `BUDGET_BURN_MAX_ROWS` is 100. With 133
  requesters in one scope the list truncates on the first page and must say so.
- Ranking must change. "Flagged first, then MoM% desc" alone sorts an unflagged
  ₨400k consumer below a flagged ₨6k one.

**Recommended default:** flagged rows first, ordered by MoM% descending; then
every other requester by this month's Consumed descending; limit unchanged at
25 with the panel printing `Showing 25 of 133 requesters · 7 highlighted`.
Pagination is a non-goal for this wave.

### Finding 4 — the aggregate only knows the selected month's requesters

`summarizeCreators(currentRows, …)` and the `identity` map are both built from
the **selected month's** rows only
(`app/api/v1/analytics/executive/budget-burn/route.ts:104,117`). A requester who
consumed ₨200,000 in M−1 and nothing in M has no row today and would have no
row under the proposal either — they would simply be absent from a panel whose
entire purpose is the three-month pattern. They are also precisely the pattern
a reviewer wants to see.

**The listed set must be the union of the three buckets**, and identity
(`requesterName`, `employeeId`, `role`, `accountStatus`) resolved newest bucket
first. A person whose branch assignment moved mid-window keeps one row per
`userId:branchId`, unchanged and correct: the two months came out of two
different branch budgets.

### Finding 5 — "leave the 3-vs-3 code unused" is not available

Rule 02 forbids dead code. The 3-vs-3 windows, thresholds, metrics and copy
must be either replaced or deleted in the same change. This plan replaces them.

### Finding 6 — the score machinery should be kept in the response, not deleted

The proposal removes the chips and the score. Removing them from *this panel*
is right. Deleting `scoreRequester`, `BUDGET_BURN_POINTS`, the peer median and
`loadBranchBudgets` is a much larger, irreversible diff, and it invalidates the
hand-worked oracle in `tests/integration/budget-burn-api.test.ts:261` that the
whole surface is pinned by.

**Recommended default:** keep computing `score` and `reasons` and keep them in
the response; draw neither in the panel. Cost is one extra query
(`loadBranchBudgets`) already issued in parallel, and the proposal's own
"or hide behind Advanced later" becomes a UI change instead of a rebuild. If
the client has not asked for the chips back by the end of this engagement, a
follow-up ticket deletes them.

## Decisions to confirm before Wave 2

| | Recommended | Why |
|---|---|---|
| Month metric | **Consumed** (Spend + Pending), pending noted on the current cell | Finding 2 |
| Listed set | Every requester in the union of the three months, top 25 shown | Findings 3, 4 |
| Score & chips | Kept in the response, removed from the panel | Finding 6 |
| Baseline guard | ₨5,000 on the **previous month** | Restores the original strictness — see Thresholds |
| Who sees it | `SUPER_ADMIN`, `HEAD_OFFICE` — unchanged | `BUDGET_BURN_ROLES`, already correct |
| Pattern length | 3 months | The ask |

## Windows (`lib/budget-burn-risk.ts`)

`MonthWindows.trend` (two runs of three months) is replaced by
`MonthWindows.pattern` (three single-month buckets):

```ts
export const BUDGET_BURN_PATTERN_MONTHS = 3   // replaces BUDGET_BURN_TREND_MONTHS

export type MonthBucket = {
  month: string        // YYYY-MM
  start: Date
  end: Date
  /** False only for the newest bucket while the selected month is open. */
  complete: boolean
}

MonthWindows.pattern: MonthBucket[]   // oldest → newest; the last is the selected month
```

The like-with-like rule is the one already in the module, applied per bucket
rather than per run:

- selected month complete → all three buckets are whole calendar months.
- selected month in progress on day *d* → the newest bucket runs from the 1st
  to *now*; each older bucket runs from its 1st to the **end of day
  `min(d, daysInThatMonth)`**. A 31st in a February window clamps to the 28th
  or 29th, as it does today.

`monthWindows.current` stays exactly as it is — `windows.recent`,
`budgetFiltersFor` and `drillFiltersFor` all read it, and it is
`pattern[pattern.length - 1]` in everything but name. `shiftMonth`,
`monthsBetween` and `BUDGET_BURN_MAX_MONTHS_BACK` (24, bounding the *selected*
month) are unchanged; the reach behind the selection shortens from five months
to two.

## Thresholds and the flag

| Before | After |
|---|---|
| `thresholds.trendSpikePct` (15) | `momSpikePct` (15) |
| `thresholds.trendMinBaselineCents` (500 000) | `momMinBaselineCents` (500 000) |
| `BUDGET_BURN_POINTS.trend_spike` | `mom_spike` (unchanged weight, unchanged label semantics, label `+MoM`) |
| `metrics.trendPct` | `metrics.momPct` |
| `metrics.trendConsumedCents` / `priorTrendConsumedCents` | `metrics.months[]` (below) |

₨5,000 is the figure the baseline held when the comparison last *was* one month
against one month; the code carries a comment saying it was deliberately left
alone when the window widened and was therefore a third of the bar it used to
be. Moving back to month-over-month restores the original strictness with no
change of value, and that comment goes.

The flag is pure and lives beside the windows:

```ts
momFlagged = priorMonthConsumed >= momMinBaselineCents
          && momPct !== null              // growthPct returns null on a zero prior
          && momPct >= momSpikePct        // >=, so 15.0% flags and 14.9% does not
```

Two consequences to state rather than discover: a requester's **first** month
is never flagged (no prior to grow from, `growthPct` → `null`), and the flag is
about one month against one, so a quarterly orderer will flag in the month they
order. That is the client's chosen rule; the three visible columns are what
makes it legible.

`isFlagged(row)` today means *score ≥ 4*. The new predicate is a different
question and gets a different name — `momFlagged` — and `isFlagged` is renamed
`isScoreFlagged`. One word meaning two things in one module is the exact defect
the `momPct`-holding-a-3-month-figure note in the previous plan warned about.

## Reads and cost

`GET /api/v1/analytics/executive/budget-burn` issues **three**
`loadCreatorMonth` calls — one per bucket — which is the same number it issues
today (month + trend.current + trend.prior). The newest bucket keeps
`recentStart` for the late-surge figure; the older two pass `null`.
`loadBranchBudgets` and `loadScopedBranches` are unchanged. `truncated`
considers all three. No new join, no new table, no change to
`orderConditions`, the row cap or the fence.

`GET .../budget-burn/item-comparison` goes from **two** `loadProductWindow`
calls to **three**, one per bucket, each with `statusSet: "consumed"` and the
same `BUDGET_BURN_ITEM_ROW_CAP` (500). Its one-branch requirement, its Zod
schema and its fence are unchanged.

## Response shape

Both routes: `windows.trend` is replaced by
`windows.pattern: MonthBucket[]` (dates as ISO strings). On the watchlist,
`metrics` gains

```ts
months: Array<{ month: string; consumedCents: number; spendCents: number; pendingCents: number }>  // oldest → newest
momPct: number | null
momFlagged: boolean
```

and loses `trendPct`, `trendConsumedCents`, `priorTrendConsumedCents`.
`score`, `reasons`, `points`, `reasonLabels` and `thresholds` stay (Finding 6).
`flaggedCount` changes meaning to *the MoM count* and is renamed
`highlightedCount`; `unflaggedCount` is replaced by `requesterCount`, because
the list is no longer "the ones above a line".

`lib/budget-burn-item-comparison.ts`: `buildItemComparison(current, prior)`
becomes `buildItemPattern(buckets)`, returning per product + unit a `months[]`
of `{ quantity, spendCents, orderCount }` oldest → newest, plus `momPct` and
`momFlagged` on the newest pair. The full-outer merge stays: a product bought
in only one of the three months keeps its row with zeroes elsewhere, which is
the deviation the reader came for. Sort by `momFlagged` first, then by the
newest month's spend descending.

The only client of either route is this repo's own panel.

## UI

`budget-burn-watchlist.tsx`:

| Requester | Branch | *M−2* | *M−1* | *This month* | vs prev month | Orders |
|---|---|---|---|---|---|---|

- The `Spend`, `Pending`, `Share`, `3M`, `vs peers`, `Why` and `Score` columns
  go. Pending survives as "incl. ₨X pending" on the current-month cell only.
- Red applies to the current-month cell and the percentage cell together.
  **Colour is never the only indicator** (rule 09): the cell also carries a ▲
  glyph and an `aria-label` naming both amounts, the percentage and the 15%
  threshold, so the row reads correctly to a screen reader, in print and in
  monochrome.
- Subtitle: *"Last three months of consumption. Highlighted when this month is
  15% or more above the previous month. For review only — not proof of
  intent."* `SCOPE_NOTE_COPY` is unchanged and still true.
- Footer: `Showing 25 of 133 requesters · 7 highlighted.` The "below the review
  score of 4" empty state is replaced by "No requester consumed budget in this
  month and scope."
- Clicks: the name still opens the order drill-down for the selected month; the
  percentage still opens the item panel. **Recommended addition** (cheap — it
  is `drillFiltersFor` with a different bucket): each month cell opens the
  order drill-down for *that* month, which is what makes a three-column table
  answer its own question.
- `monthRangeLabel` is retained for the item panel's heading; `trendNote` and
  `trendCellTitle` are replaced by `momCellTitle`, which names both months and
  both amounts.

`budget-burn-item-comparison.tsx`: title *"Item-wise 3-month consumption"*;
columns Product | Unit | Qty ×3 | Spend ×3 | vs prev month, with the same red
treatment and the same non-colour indicator on the product row.

## Tests

- `lib/budget-burn-risk.test.ts` — the `monthWindows` block's trend assertions
  become pattern assertions: complete month, month-to-date, short-month clamp
  (31 March → 28/29 February), year boundary, and that the buckets are
  contiguous, non-overlapping and end with the selected month. The scoring
  block's `trend_spike` cases become `mom_spike`: 14.9% / 15.0% / 15.1%, zero
  prior → no flag, prior below ₨5,000 → no flag, current 0 against a large
  prior → −100% and no flag.
- `lib/budget-burn-item-comparison.test.ts` — N-bucket merge; a product present
  in only the oldest bucket; a product present in only the newest; per-product
  MoM and its baseline guard; units never combined.
- `lib/server/budget-burn-queries.test.ts` — the contract list: the route reads
  one aggregate per pattern bucket, still through `orderConditions`, still at
  order grain, still `.limit(BUDGET_BURN_QUERY_ROW_CAP)`, still role-narrowed
  before any read. Add an assertion that the listed set is the union of the
  buckets, not the selected month alone (Finding 4).
- `lib/server/budget-burn-item-queries.test.ts` — the "reads the same two trend
  windows" assertion becomes "reads the same pattern buckets the highlighted
  percentage was built from".
- `components/reports/executive/budget-burn-watchlist.test.tsx` — red at 15.0%
  and absent at 14.9%; the non-colour indicator and the `aria-label` present;
  the three month cells; the new footer and subtitle copy; a requester with no
  current-month orders still listed.
- `components/reports/executive/budget-burn-item-comparison.test.tsx` — same,
  at product grain.
- `tests/integration/budget-burn-api.test.ts` — **the largest single piece of
  work.** The August 2026 fixture was built for 3-vs-3 and its oracle is hand
  worked; it is restated for three month buckets, including: the union rule
  (a requester with M−1 consumption and no M consumption appears), the
  reconciliation of each month cell against the drill-down for that month, the
  item panel's three totals against the three buckets, and the unchanged 401 /
  403 / cross-tenant / role cases, which must not move.

Nothing in the access-control, tenant-isolation or validation blocks changes.
If one of them needs editing to pass, that is a defect in the change, not in
the test.

## Documentation

The `CLAUDE.md` "Budget-burn watchlist" entry currently states the 3-vs-3 rule
and the item panel's coupling to it as load-bearing. It is rewritten in the
same commit: the pattern is three months, the highlight is the newest pair, the
item panel reads the same buckets, and rules (1) role list, (2) branch
denominator on `orders.branch_id` keyed to `ORDER_CREATOR_ROLES`, and (3) the
`consumed` drill-down status set are unchanged and still load-bearing.

## Non-goals

No headcount or per-capita fairness. No "deliberate burn" wording, and nothing
on this panel asserts intent. No approval caps, soft or hard. No Branch Admin
access to Graphical Reports — `EXECUTIVE_ANALYTICS_ROLES` and
`BUDGET_BURN_ROLES` are untouched, and the integration suite's refusal of
`BRANCH_ADMIN` and of the multi-branch approver stands. No pagination. No
change to budgets, holds, pricing or order behaviour. Nothing is approved,
blocked or charged from a red cell.

## Risk and rollback

Presentation only, on a read-only surface behind an authorization boundary that
does not move. The behavioural risks are (a) the panel now lists every
requester rather than seven, which is a volume change on an already-bounded
read, and (b) the month-over-month rule will flag a quarterly orderer where the
3-month rule did not — stated above as the client's chosen trade. Rollback is
reverting the commit. No migration, no backfill, no data written.

## Waves

| | | |
|---|---|---|
| 1 | Confirm the six decisions above | ½ day |
| 2 | `budget-burn-risk.ts` — pattern buckets, `momFlagged`, renames + unit tests | 1 day |
| 3 | Both routes — three buckets, union listing, response shape + contract tests | 1 day |
| 4 | Both panels — columns, red state, non-colour indicator, copy + component tests | 1 day |
| 5 | Integration oracle restated, `CLAUDE.md` rewritten | 1–1½ days |
| 6 | QA against KE-like data (quiet user on a tiny base, heavy flat user, a real +15%, a product split, a requester absent this month); role check HO/SA only; drill-down reconciles with each month cell | ½ day |

**3½–5 engineering days**, against the proposal's 4–6. The saving is Finding 6
(the score is hidden, not excised); the cost the proposal missed is Wave 5.

## Success criteria

Three months of consumption per requester and per product are on the screen.
A row goes red when, and only when, this month is at least 15% above the
previous month from a baseline of at least ₨5,000. No other signal is needed to
read the panel. Every month cell reconciles with the order lines behind it.

## Gates

`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and
`npm run test:integration` against the disposable Postgres — reporting whether
it ran or skipped, since it passes silently without `TEST_DATABASE_URL`.
