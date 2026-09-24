# OF-BUDGET-BURN — the growth signal becomes 3 months against the prior 3

Refines one signal in the "Users to review" watchlist shipped by
`plans/OF-BUDGET-BURN-watchlist.md` and refined by
`plans/OF-BUDGET-BURN-branch-peers-and-mom-items.md`. Read-only, no schema
change, no new role, no write path.

## The change

**Before:** the `MoM` column compared a requester's consumption *this month to
date* against *the prior month to the same day*. A single month is a short
baseline — one large order in either month swings the figure, and a requester
who orders quarterly reads as a spike in the month they order and a collapse
in the two either side.

**After:** the column compares the **three months ending with the selected
month** against the **three months before those**. For July 2026: May + June +
July against February + March + April.

**Everything else stays on the selected month.** Spend, Pending, Share,
Orders, Late surge, High held, Rejected orders, `Above peers`, the branch
denominators, the budget rows and the month navigation are untouched — this
is a change to one comparison's time range, not to what the panel is about.
A consequence worth stating: the growth figure is therefore no longer a ratio
of the Spend shown beside it. The tooltip and the panel's subtitle name both
3-month ranges and their totals so the number can be reconciled.

## Windows (`lib/budget-burn-risk.ts`)

`MonthWindows.prior` — the prior *month*, which existed only to feed the MoM
figure — is replaced by `trend`:

```ts
export const BUDGET_BURN_TREND_MONTHS = 3

export type TrendWindow = { startMonth: string; endMonth: string; start: Date; end: Date }

MonthWindows.trend: { months: number; current: TrendWindow; prior: TrendWindow }
```

The like-with-like rule the month window already used carries over unchanged,
shifted by three months instead of one:

- month complete → `current` is three whole months, `prior` is the three whole
  months before them.
- month in progress on day *d* → `current` runs from the 1st of `month − 2` to
  *now*; `prior` runs from the 1st of `month − 5` to the **end of day *d*** of
  `month − 3`, clamped when that month is shorter. Both sides then cover the
  same whole number of days.

`previousMonth` is replaced by a general `shiftMonth(year, month, delta)`.
`BUDGET_BURN_MAX_MONTHS_BACK` (24) is unchanged and still bounds the *selected*
month; the prior window may reach five months further back, which is a read of
older rows and nothing more.

## Scoring (`lib/budget-burn-risk.ts`)

The reason, its threshold and its metrics are renamed, because a field called
`momPct` holding a three-month figure is a lie a future reader would believe:

| Before | After |
|---|---|
| `BUDGET_BURN_POINTS.mom_spike` (2 pts) | `trend_spike` (2 pts, unchanged) |
| label `+MoM` | label `+3M` |
| `thresholds.momSpikePct` (15) | `trendSpikePct` (15, unchanged) |
| `thresholds.momMinBaselineCents` (500 000) | `trendMinBaselineCents` (500 000, unchanged) |
| `metrics.momPct` | `metrics.trendPct` |
| `metrics.priorConsumedCents` | `metrics.priorTrendConsumedCents` |
| — | `metrics.trendConsumedCents` (new: the current 3-month total) |

`scoreRequester` gains `trendConsumedCents` beside `priorTrendConsumedCents`,
because the current side of the comparison is no longer the row's own month
consumption. `buildWatchlist`'s single `priorByKey` becomes
`trendConsumedByKey` and `priorTrendConsumedByKey`.

Both thresholds keep their values, per the request to change only the time
range. Stated plainly so it is a decision and not an oversight: a ₨5,000
baseline over three months is a third of the bar it was over one, so the
`trend_spike` point will be awarded more often than before. Raising it to
₨15,000 is a one-line change to `trendMinBaselineCents` if the client wants
the old strictness back.

## Reads

`app/api/v1/analytics/executive/budget-burn/route.ts` calls `loadCreatorMonth`
three times instead of twice — the selected month (with the late window), the
current trend window, the prior trend window — because the month aggregate
still feeds Spend/Share/Late surge and neither trend window can be derived
from it. Each is the same bounded, `orderConditions`-fenced grouped aggregate;
`truncated` now considers all three.

`GET .../budget-burn/item-comparison` swaps `windows.current`/`windows.prior`
for `windows.trend.current`/`windows.trend.prior`. Its fence, its
one-branch requirement, its Zod schema and its row cap are unchanged.

## Response shape

`windows.prior` (a month) is replaced by `windows.trend: { months, current:
{ startMonth, endMonth, startDate, endDate }, prior: { … } }` on both routes.
The only client is this repo's own watchlist panel.

## UI

- `budget-burn-watchlist.tsx`: column `MoM` → `3M`; the subtitle names both
  ranges and drops "prior month is …"; the cell tooltip prints both 3-month
  totals; `reasonExplanation("trend_spike")` says "on the prior 3 months".
- `budget-burn-item-comparison.tsx`: title "Item-wise 3-month comparison";
  columns `Qty last 3 months` / `Qty prior 3 months` / `Spend last 3 months` /
  `Spend prior 3 months`; the header line names both ranges.
- A `monthRangeLabel(startMonth, endMonth)` helper renders `May–Jul 2026`
  (and `Jul 2026` when a range is one month), exported for the tests.

## Tests

- `lib/budget-burn-risk.test.ts` — the `monthWindows` block gains trend-window
  assertions (complete month, month to date, short-month clamp, year
  boundary); the scoring block's `mom_spike` cases become `trend_spike` over
  the two new inputs.
- `components/reports/executive/budget-burn-watchlist.test.tsx` and
  `budget-burn-item-comparison.test.tsx` — fixtures and copy assertions.
- `lib/server/budget-burn-item-queries.test.ts` — the route contract asserts
  the item route reads the trend windows.
- `tests/integration/budget-burn-api.test.ts` — the existing August fixture is
  extended so the trend windows have something to hold, and the hand-worked
  oracle is restated for the 3-month figures.

## Risk and rollback

Presentation only; nothing is approved, blocked or charged from the score.
Rollback is reverting the commit. No migration, no backfill.

## Gates

`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and
`npm run test:integration` against the disposable Postgres — reporting
whether it ran or skipped.
