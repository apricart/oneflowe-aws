# OF-EXEC-ANALYTICS — Test coverage for the Compare Side by Side tab

## Why

The tab is served by three route handlers — `/api/v1/analytics/executive/compare`,
`/options`, `/drill-down` — plus `/overview` for the unit list. Until now they
were covered by unit tests of the pure registry and request parser, a mocked
test of the scope resolver, and contract tests that read the SQL builders'
source. Nothing executed the SQL, nothing exercised a route end to end, and the
401 / 403 / cross-tenant behaviour rule 04 requires of every protected endpoint
was verified only by reading. The production pipeline ran `npm test` alone.

## What this adds

### Integration (`tests/integration/`, real Postgres, only identity faked)

`helpers/executive-analytics-fixtures.ts` builds two tenants:

```
organization A                                   organization B (neighbour)
  branch North, branch South                        branch Foreign
  requesters: Ahmed (North), Sana (South),           requester: Foreign user
              Group requester (orders at both)
  category Stationery ─ subcategory Paper            product Foreign Product
  products: Paper (Ream), Toner (Piece),
            Diesel (Litre)
  orders across three months, statuses
  FULFILLED / APPROVED / PARTIAL / PENDING /
  CANCELLED, one APPROVED refund
```

The rows are chosen so every figure the tab shows has a hand-computable answer:
whole-order vs line-by-line money, refund netting, status exclusion, one product
sold in two units, a person at two branches, and a neighbour whose rows must
never appear. Every row carries a unique suffix; `destroy…` removes them in
foreign-key order.

`executive-analytics-api.test.ts` drives the four routes with `NextRequest`,
`getServerSession` mocked, rate limiting stubbed:

* **Access** — 401 without a session; 403 for BRANCH_ADMIN, ORDER_PORTAL and
  GROUP_ORDER_PORTAL on every route; 403 for a session that *claims*
  HEAD_OFFICE while the user row says BRANCH_ADMIN (the row is the truth).
* **Tenant isolation** — Head Office A never sees B's branches, products, people
  or lines, even when B's ids are passed as `organizationIds`, `branchIds`,
  `keys` or a drill-down `key`; foreign ids narrow to nothing rather than
  widening. Super Admin with no tenant sees both; with a tenant, one.
* **Every side-by-side panel** — compare by product, requester, branch, month,
  requesters-over-months (series), products-over-months, day (series), under
  Amount and Quantity, against hand-computed totals.
* **Counting rules** — pending/cancelled excluded, approved refund deducted,
  whole-order money with no focus vs line-by-line money with a product focus,
  quantity blocked across mixed units, unit selected, requester filter narrows
  the branch and month panels.
* **Pickers** — one row per product with every unit in the hint, one row per
  person at two branches, lists narrowed by the other picker, unit ignored.
* **Drill-down** — totals reconcile with the bar for Amount and for Quantity,
  month click clips to the month, person·month click narrows both, sort
  allowlist, paging, unit-per-total, row `lineId` unique.
* **Overview** — the unit list the filter bar's Unit selector is built from.

### Unit (`npm test`, jsdom)

* `entity-picker.test.tsx` — search, toggle, 25 cap, trigger labels, clear.
* `measure-toggle.test.tsx` — pressed state, disabled reason.
* `chart-kit.test.tsx` — ChartCard states (loading / error / empty / table
  toggle / formula), formatters, `Legend` keys.
* `drill-down-panel.test.tsx` — request URL carries every filter, sort toggles,
  paging resets on a new target, per-unit totals, budget-figure note.
* `comparison-charts.test.tsx` — every chart form's legend, footnotes and
  drill affordance; the table and series-table forms; the scatter's empty case.
* `side-by-side-workspace.test.tsx` — extended: the six default panels and
  their request parameters; measure switch keeps focus, selection and
  drill-down; requester keys reach the requester panels only; single-product
  layout and back; subject sentence variants; clear selection; blocked, unit
  and empty messages; full-width ordering; day panel has no checkbox.
* `app/(portal)/reports/graphical/page.test.tsx` — the role gate renders the
  refusal and fetches nothing; the three tabs; the shared filter row opens on
  this quarter; a failed overview request does not hide the tabs.
* `components/reports/quick-date-range.test.tsx` — see incidental fixes.

The request parser (`lib/executive-analytics-request.ts`) was already covered
by `lib/executive-analytics.test.ts` and `lib/executive-analytics-drilldown.test.ts`;
nothing was added there.

### Pipeline

Both workflows gain a disposable Postgres 16 service container, migrate it
with `MIGRATION_DATABASE_URL`, and run `npm run test:integration` with
`TEST_DATABASE_URL` pointing at it. The step asserts the suites actually ran
(the runner prints `running against` on stderr; a skipped run prints
`will SKIP`) so a mis-set variable fails the build instead of passing it
silently. `deploy-prod.yml` runs it in `build-and-report`, before the image is
built, so a failing commit never reaches ECR or the approval queue.

## Not changed

Any route, any query, the scope resolver, the registry. The safety guards in
`tests/setup/integration-env.ts` (test-named database, `.env.local` ignored)
are relied on, not relaxed.

## Risk and rollback

Tests and workflow only. The service container is per-job and discarded. A
failing integration step blocks a deploy — which is the point; reverting the
workflow change restores the previous gate.

## Incidental fixes the new tests forced

* **`getDateRange` was a day early east of UTC** (`components/reports/quick-date-range.tsx`).
  It built the range start at local midnight and formatted it with
  `toISOString()`, which converts to UTC first — so for every reader in Pakistan
  "This Month" and "Quarter" began on the last day of the previous month, and
  "Today" meant yesterday until 05:00. Every report using the control was
  affected. Now formatted as the local calendar date (`toCalendarDate`), with
  `quick-date-range.test.tsx` pinning it. The existing
  `executive-filters.test.tsx` assertion had reproduced the same conversion and
  was agreeing with the bug; it now asserts the local date.
* **`destroyPricingFixtures` could not delete its user** because the price
  routes write an `audit_logs` row against it. The existing
  `organization-price-propagation` suite failed at teardown on any database
  that had run it once — unnoticed because the suite had never run in CI.
* **A green integration run exited 1.** The pool logs its connect/remove
  events through `console.log`, the `remove` events fire while `closePool()`
  drains in `afterAll`, and Vitest 4 reports a log pending at worker shutdown
  as an unhandled error. `tests/setup/integration-env.ts` now drops the pool's
  own chatter (and nothing else) for the integration project.
