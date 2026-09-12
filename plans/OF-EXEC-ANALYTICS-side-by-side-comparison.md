# OF-EXEC-ANALYTICS — Side-by-side comparison, drill-down and consumption

## What exists today

`/reports/graphical` is the Executive Analytics Center, gated to `SUPER_ADMIN`
and `HEAD_OFFICE` by `EXECUTIVE_ANALYTICS_ROLES` and re-checked server side by
`resolveExecutiveScope`. Two levels:

* **Executive Overview** — eight fixed visuals (budget vs consumed, trend,
  utilization ranking, attention list, category pareto, branch × category
  heatmap, status composition, price variance).
* **Explore & Compare** — a five-step question builder that renders **one**
  chart: compare by *one* dimension, optionally focused on products, measured
  by one metric, drawn as one chart form.

### Gaps against the request

| Asked for | Today |
|---|---|
| Product across users **and** branches **and** months on one screen | One dimension at a time |
| Users vs users beside the rest | Only as its own separate chart |
| Multi-colour differentiation of entities | Ranked bars are one hue |
| Click a bar/point → the detailed table | Clicking a bar *adds it to the selection*; there is no detail table anywhere |
| Detail table keeps the same month/period and filters | No detail table |
| Amount ⇄ Quantity toggle without losing filters | Buried in a seven-option "Measured by" row |
| Month + product → day-by-day consumption | No day grain at all |
| Who consumed more, users and branches compared | Possible, one chart at a time |

### Two defects found while reading

1. **`month` + "Trend over time" draws nonsense.** `loadEntitySeries` treats the
   dimension as the *entity* and the month as the *period*, so comparing by
   month produces one series per month, each a single spike. "Trend over time"
   is the first chart offered for `month`, so this is what a reader gets by
   default when they compare months.
2. **Month bucketing ignores the application timezone.** `TO_CHAR(created_at,
   'YYYY-MM')` uses the database session zone, while budgets in the same module
   bucket through `buildAppMonthPeriods` (Asia/Karachi). Orders placed between
   00:00 and 05:00 Karachi land in the wrong month, and budget utilization and
   the month comparison disagree at every boundary.

## What is built

### 1. A `day` dimension (registry)

`day` joins `month` as a time-axis dimension: not selectable, activity metrics
only, chart menu limited to line/column/table. Capped at
`MAX_TIME_AXIS_POINTS` rows so a two-year range cannot ask for 730 buckets.
This is what makes "pick a month and a product, see day-by-day consumption" an
ordinary comparison rather than a bespoke endpoint.

### 2. Time-axis series fixed, and bucketed in app time

`loadEntitySeries` returns **one** series over the periods when the dimension is
itself the time axis. Month and day keys both go through
`(created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi'`, the convention
already used by `weekly-sales`, `yearly-sales`, `sales-performance` and
`organization-stats`, so the month comparison now agrees with the budget
periods next to it.

### 3. `GET /api/v1/analytics/executive/drill-down` (new)

The only new endpoint. Given the same filters the chart was drawn with, plus the
clicked `dimension` and `key`, it returns the order **lines** behind that bar —
order, date, branch, requester, product, quantity, unit price, line value,
status — with totals computed over the whole match, not the page.

* Scope: `resolveExecutiveScope`, identical to its two siblings (401/403).
* The clicked key is folded through the existing `applyEntityKeys` path, so a
  branch or organization key is intersected with the caller's fence rather than
  trusted; month and day keys narrow the window instead.
* Sort keys come from an allowlist; `limit` is clamped; rate limited as
  `search`.
* No new price exposure: both roles that can reach this already read prices.

### 4. Side-by-side workspace (new third tab)

One screen, one focus (products), one measure toggle, five panels drawn from a
registry — by requester, by branch, by month, requesters over months, and
day-by-day when exactly one product is focused. Every panel is a call to the
*existing* `/compare` endpoint with a different `dimension`, so no new
aggregation path and no new authorization surface.

Clicking any bar, column, slice or point opens the shared drill-down table
below, carrying the same period and filters. Switching Amount ⇄ Quantity keeps
the focus, the filters, the selection and the open drill-down.

### 5. Multi-colour entity charts + click-to-drill

`ComparisonChart` gains `colorful` (per-entity hue on ranked bars and columns
for entity dimensions; time axes stay one hue) and `onDrillDown`, wired on
bars, columns, slices, scatter points and line points.

## Not changed

Role gate, scope resolution, the metric/dimension whitelist, budget arithmetic,
the Executive Overview, every other report, and every non-executive role's view
of anything.

## Tests

* Registry: `day` pairings, time-axis chart menus, drill-down clamps, panel
  registry integrity, measure toggle pairing.
* Request parsing: drill-down validation, sort allowlist, window narrowing for
  month and day keys, role refusal.
* Contract: the drill-down route is scoped through `resolveExecutiveScope` and
  never reads a branch id straight from the request.

## Risk and rollback

Additive. No schema change, no migration. The two behavioural corrections
(time-axis series, app-timezone month buckets) are confined to the Executive
Analytics Center. Reverting the commit restores the previous page exactly.

## Addendum — item-wise comparison on the side-by-side screen (2026-09-13)

### Gap

The requirement asks for comparison "across items/products, users, branches
and months … in one screen". The side-by-side screen compared users, branches
and months, but products were only ever the *subject*: ticking three products
gave their combined figure per requester and per branch, never three bars.
Product-vs-product lived only on Explore, one question at a time.

### Change

Two entries in `SIDE_BY_SIDE_PANELS`, both served by the existing `/compare`
endpoint with `dimension=product` — no new aggregation path, no new
authorization surface, no schema change:

* **By product** — ranked bars, `chart: "bar"`, one hue per product.
* **Products over months** — `chart: "line"`, one line per product.

Both are withheld when exactly one product is in focus (`hiddenForSingleProduct`),
where a single bar or a single line would restate the subject; the day-by-day
panel already covers that case. With no focus they rank the top products in
scope; with several products ticked they compare exactly those, because the
focus already travels as `productIds`.

`panelsForFocus` honours the new flag alongside `requiresSingleProduct`. The
subject sentence names products among the compared dimensions when the product
panels are on screen.

### Tests

Registry: product panels support both measures and draw an allowed form
(existing loops); product panels hidden for one focused product and present
for zero or several; the screen covers product as well as requester, branch and
month.

### Risk and rollback

Additive registry entries. Removing the two entries restores the previous
screen exactly.
