# OF-SUPPORT — searching the queue by order id

## The ask

The support queue lists requests and filters them by status and category. A
request that cites an order shows that order's reference on its row, but there
is no way to go the other way: given an order id, find the request about it.
Support staff work from an order the customer quotes, so that is the lookup
they actually need.

## What exists already

`GET /api/v1/support/threads` accepts `orderId` — the **internal** numeric
primary key — and `reference` (`SUP-000123`). Neither is what a person has in
front of them. What the row displays, and what a customer quotes, is
`orders.tid` (`varchar(26)`), which no filter matches. The UI sends neither
parameter and has no search field at all.

## The change

1. **`lib/support-thread.ts` (pure)** — `parseSupportOrderSearch` turns an
   untrusted parameter into either "no search" or a bounded term, and
   `supportOrderSearchId` says whether the term is plainly an internal order
   id. Both unit-tested; no database, no request.
2. **`lib/server/support-threads.ts`** — a new `orderSearch` filter, matching
   `orders.tid` case-insensitively and, when the term is all digits, the
   internal id as well. Mirrors `addOrderSearchCondition` in the orders route,
   which is the settled pattern for the same lookup.
3. **`app/api/v1/support/threads/route.ts`** — parse the parameter, 400 on a
   term longer than the column that holds it.
4. **`components/support/support-list.tsx`** — a debounced search field beside
   the existing selects, capped at the same length, clearable.

## Decisions

- **The term is matched with `EXISTS`, not a predicate on the joined `orders`
  row.** `listSupportThreads` shares one `where` between a count query that
  reads `support_threads` alone and a row query that joins `orders`. A
  predicate naming `orders.tid` would force the join into the count query too;
  `EXISTS` keeps the shared predicate self-contained and is a primary-key
  lookup either way.
- **A term longer than 26 characters is refused, not truncated.** `orders.tid`
  is `varchar(26)`, so a longer term cannot match one. Truncating it would
  silently search for something shorter — and therefore broader — than what was
  typed.
- **The term is escaped through `escapeLikePattern`.** A typed `%` searches for
  a percent sign; it does not turn the filter into "everything".
- **The search narrows, it never widens.** The condition is pushed onto the
  same `conditions` array that always starts with `supportScopeCondition`, so
  it is ANDed under the tenant predicate. Searching an order belonging to
  another tenant returns nothing, exactly as an unsearched list would.
- **The unread badge stays scope-wide**, unfiltered by the search, as it
  already is for status and category.
- **Both sides get the field.** The list component serves Apricart and the
  customer; a customer looking up their own order is the same lookup, already
  scoped to their own threads.

## Tests

- `lib/support-thread.test.ts` — the parser: blank, whitespace, trimming, the
  length ceiling, a non-string, and which terms name an internal id.
- `lib/server/support-boundaries.test.ts` — contract: the term is escaped, is
  never `sql.raw`, reaches the query through the pure parser, and is ANDed onto
  the scoped `conditions` rather than replacing them.
