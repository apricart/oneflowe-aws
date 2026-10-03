# OF-TABLE — Sort by any column on the Orders page and every report table

## Requirement

Every column header in the Orders table and in every table under the Reports
menu sorts the table, the way the Budgets table already does: click a header to
sort by it, click again to reverse, a faded ⇅ on columns that are not sorted and
↑ / ↓ on the one that is.

## Two kinds of table

| Table | Rows on the client | Where the sort runs |
|---|---|---|
| Orders (`components/orders/orders-directory.tsx`) | one page of 25 | server — `GET /api/v1/orders` |
| Order Report | one page | server — `GET /api/v1/analytics/summary` |
| Refund Report | one page | server — `GET /api/v1/analytics/refunds` |
| Organization, Budget, Product (×2), User, Branch, Group, Group Order (×2) | the whole filtered set | client |

Sorting one page of a paginated list on the client would reorder 25 rows and
present it as the order of the whole list, which is wrong. The three paginated
endpoints therefore take the sort, and it is applied before `LIMIT/OFFSET`.

## Shared pieces

- `lib/table-sort.ts` — pure. `SortState`, `nextSortState` (same column flips,
  new column starts at the column's first direction: A→Z for text, high→low for
  numbers and dates), `compareSortValues` (natural, case-insensitive; blanks
  last in both directions), `sortRows` (stable), and `parseSortParams`, which
  admits a `sort` key only from the endpoint's allowlist.
- `lib/server/sort-sql.ts` — `orderBySortSql(expression, direction)` →
  `expr ASC|DESC NULLS LAST`. The direction is one of two literal fragments,
  never a request string.
- `components/reports/sortable-header.tsx` — `SortableHeader` (the button in a
  header cell), `ariaSortFor`, `useTableSort`.

## Server sort (security)

- Query parameters `sort=<key>&dir=asc|desc`. The key must be in the endpoint's
  allowlist (an exported constant in `lib/`); anything else is 400. The key maps
  through a `Record<Key, SQL>` in the route to a column or an expression already
  in the query — no request text reaches SQL.
- A tie-breaker on the primary key (`id DESC`) keeps pages stable.
- No change to authentication, authorization, tenant scoping, the filters, the
  page-size bound, or the response shape. Without `sort` each endpoint returns
  exactly the order it returned before.

## Not in scope

The Executive Overview and Product Performance dashboards (charts, with their
own drill-down sort), and CSV/PDF exports, which keep their existing order.

## Tests

- `lib/table-sort.test.ts` — toggling, comparison, blanks, stability, allowlist.
- `components/reports/sortable-header.test.tsx` — icons, `aria-sort`, click.
- A contract test that each paginated endpoint parses its allowlist and that
  every report table renders sortable headers.
