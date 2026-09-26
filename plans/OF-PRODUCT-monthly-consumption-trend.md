# OF-PRODUCT — Monthly consumption trend (line chart)

## What

The Product Intelligence screen (`/reports/product-performance`, Analytics tab)
answers *how much* of each product moved, but not *when*. The bar chart beside
it is one series over months (revenue, or fulfilled quantity when prices are
hidden) — it cannot show that one product is climbing while another falls.

Add a second chart to the same tab: **quantity consumed, by month, one line per
product, top N by consumption**. X-axis Jan → Dec of the selected window,
Y-axis quantity, default five lines.

## The measure

**Consumed = fulfilled quantity, net of approved/completed refunds**, over the
orders the product report already counts (`FULFILLED`, `REFUNDED`, `APPROVED`,
`PARTIAL`, `PARTIALLY_FULFILLED`).

That is exactly the `qtyFulfilled` the same screen already prints in its
"Qty Fulfilled" KPI and its product table, and exactly what the bar chart plots
when prices are hidden. It must stay exactly that: the line chart sits directly
under figures derived the same way, and a reader will add the cells up.

This is **not** the budget sense of "consumption" (`spent + held`, money) from
`lib/budget-consumption.ts`. That rule names a money figure on a branch/month
ledger row; this one names a count of units of a product. They are different
questions and deliberately do not share a module.

## The month bucket

`productTrendMonthKey` in `lib/product-consumption-trend.ts` is the single
derivation, and the existing `buildProductTrend` in the performance route is
refactored onto it. The two charts sit one above the other on the same screen
and are filtered by the same controls, so an order must land in the same month
in both or the line chart will visibly contradict the bar chart above it.

The key is deliberately *not* changed in this work: it is what the bar chart
has always used. Correcting the bucketing is a separate change that then moves
both charts together, which is the point of extracting it.

## Where the data comes from

A new route, `GET /api/v1/analytics/products/consumption-trend`, rather than a
field on `/analytics/products/performance`:

- The performance route is read four times per page load (all-time, global,
  chart, ranking). A per-product-per-month matrix on every one of those is
  payload nobody asked for.
- The line chart carries a filter the performance route does not have
  (category) and a bound the performance route does not have (series count,
  month count).
- That route is already 600 lines and owns a different shape.

The branch fence is the one the performance route already uses, extracted
unchanged to `lib/server/product-analytics-scope.ts` so both routes resolve
branches through one function rather than two copies.

## Bounds

Every one is a constant in `lib/product-consumption-trend.ts` and is exported
so the UI can print it:

| Bound | Value | Why |
|---|---|---|
| `CONSUMPTION_TREND_DEFAULT_SERIES` | 5 | what was asked for |
| `CONSUMPTION_TREND_MAX_SERIES` | 8 | the categorical palette has eight slots; a ninth line would have to repeat a colour |
| `CONSUMPTION_TREND_MAX_MONTHS` | 24 | "All time" on a tenant with four years of history is not a readable axis; the most recent 24 months are kept |

Products past the limit are folded into a single **Other** total per month
rather than dropped, so the column still sums to the tenant's real consumption.

## Filters

Asked for: date range, branch, product category, product, department.

| Asked | Served by |
|---|---|
| Date range | the card's own Months + Years multi-selects, as the bar chart beside it has; `startDate`/`endDate` are accepted by the route too |
| Branch | `branchIds` — the existing `BranchFilter` |
| Department | `groupIds` — a group *is* the department tier here (KE's Distribution / Enabling / Tranmission groups). The filter is labelled **Groups**, the name the rest of the application uses, rather than adding a second word for one thing. |
| Product category | `categoryIds` — **new**; the filter offers top-level categories while products hang off subcategories, so it matches `categories.id IN (…) OR categories.parent_id IN (…)`, the rule `categoryProductFilter` already uses in `lib/server/executive-analytics-queries.ts` |
| Product | `productIds` — the existing `ProductFilter` |

## Security

- Authenticate, then resolve the organization through
  `resolveAnalyticsOrganizationIds` (every role but Super Admin is pinned to its
  session organization) and the branches through the extracted
  `resolveProductBranches` (branch-scoped roles pinned to their own branch,
  group roles to their assignment set, an empty set refused rather than
  widened). Identical to the performance route because it is the same function.
- No price leaves this route. The response carries quantities only, so
  `pricesHidden` changes nothing here — but it is still reported on the payload
  so the card can label itself consistently with the rest of the screen.
- `categoryIds`, `productIds`, `groupIds`, `branchIds`, `months`, `years` and
  `limit` are all parsed to positive integers; nothing reaches SQL as a string.
- Rate limited on the `search` bucket, as the executive matrix route is, for
  the same reason: it is an aggregate a caller could otherwise sweep.

## Tests

- `lib/product-consumption-trend.test.ts` — the ranking, the Other fold, the
  refund netting, the month-window resolution and its 24-month cap, the empty
  month fill, and that the month key matches the performance route's.
- `tests/integration/product-consumption-trend.test.ts` — 401 unauthenticated,
  403/empty for a branch-scoped role outside its branch, cross-tenant refusal,
  a hand-worked two-product/three-month oracle, and the category filter
  matching through a subcategory.
