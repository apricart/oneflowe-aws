# OF-SUPPORT — retire the Billing category, cite a product on a query

## Requirements

1. "Billing & payment" is no longer offered when raising a query.
2. After Category, the requester can search their organization's products and
   attach one to the query. The field reads as the Category select beside it,
   with a search box in the panel. It is **required for every category but
   "Other"**, where it stays optional.
3. The chosen product shows everywhere in the support UI that it matters.

## Decisions

### Retiring a category is not the same as deleting it

`BILLING` stays in `SUPPORT_CATEGORIES`, in `SUPPORT_CATEGORY_LABELS`, and in
the `support_threads_category_valid_ck` constraint. It is removed from a new,
narrower list — `SUPPORT_SELECTABLE_CATEGORIES` — which is what the dialog
renders and what `supportThreadCreateSchema` accepts.

The reason is that a thread already recorded as `BILLING` still has to render
with its proper label and still has to be findable. Dropping the member from the
union would make `isSupportCategory("BILLING")` false, and the existing row
would print a raw `BILLING` in the list and fall out of the filter. Narrowing
the *write* path costs nothing and breaks nothing.

So: **the create dialog offers the selectable list; the list's filter keeps the
full vocabulary**, because a filter exists to reach rows that exist. This
database has no `BILLING` rows today, but production is not this database.

The two lists are declared separately (a `z.enum` needs a literal tuple) and a
test asserts that selectable is exactly the vocabulary minus the retired set, so
they cannot drift.

### The field is a select with a search box, not a bare text input

The requester meets it beside Category and Priority, so it behaves like them: a
trigger showing the current choice, a panel of options underneath. What it adds
is a search box at the head of that panel, because a tenant's catalogue runs to
thousands of rows and a plain option list is unusable at that size.

It is assembled from a button and a listbox rather than a Popover/Command
pairing. This lives inside the raise-a-query Dialog, and nesting one Radix
portal with its own focus trap inside another is a reliable source of focus
bugs; an inline, absolutely positioned panel needs neither. Filtering stays on
the server — only the first twenty matches are fetched, and filtering those
again client-side would hide results the server did return.

### The product is required unless the category is "Other"

`isProductRequiredForCategory` in `lib/support-thread.ts` is the rule: every
category but `OTHER` describes something in the catalogue — an invoice line, an
order line, a delivery, a product — and a request that does not say which
product it concerns cannot be triaged without a round trip asking. `OTHER` is
the category for everything that is not about a product, so it alone may leave
the field blank.

The rule is stated once and applied twice. The dialog drops the "(optional)"
mark, refuses to submit, and shows the message under the field; that is
presentation. `supportThreadCreateSchema` applies the same predicate in a
`superRefine`, with `path: ["productId"]`, because a caller posting straight at
the endpoint never sees the dialog, and a requirement only the UI enforces is
not a requirement. An explicit `null` is refused alongside an omitted field — a
stated absence is still an absence.

### The product reference mirrors the order reference

The thread already cites an order, and everything about that is the pattern to
follow: a nullable column, `ON DELETE SET NULL` so the conversation outlives its
subject, and a server-side check that the *caller* may cite the thing.

- `support_threads.product_id` → `global_products.id`, nullable.
- `verifyProductReference` sits beside `verifyOrderReference` and enforces the
  one rule that matters: **the product must be assigned to the author's own
  organization** (`organization_inventory`, active, not soft-deleted). A
  requester cannot attach a product their tenant does not carry, and cannot
  probe another tenant's catalogue by id — a product outside their organization
  is refused with the same message as one that does not exist.
- The id is validated on the server against the author's organization from the
  session. Nothing about scope comes from the request.

`global_products` is the referent rather than `organization_inventory` because
the thread already carries its `organization_id`; the pair resolves the org's
custom name, and the reference survives the org later disabling the assignment
(the conversation is still about that product).

### The catalogue is `organization_inventory`, not `organization_products`

Two tables carry the same shape — an organization, a global product, a custom
name, an enabled flag. Only one is the catalogue. `organization_inventory` is
what `POST /api/v1/admin/organization-assignments` writes when Apricart assigns
a product to a tenant, and what `branch_inventory` references to build the
store. `organization_products` is written by nothing in the application — only
`scripts/sync-ke.ts`, which writes both — and every other reader of it uses a
`LEFT JOIN`, so its emptiness has never shown.

An `INNER JOIN` against it is therefore an empty result for every tenant whose
catalogue was assigned through the portal. This feature had three: the picker's
search returned nothing, `verifyProductReference` would have refused every
submission, and the thread list resolved no custom name. All three read
`organization_inventory`, and the contract test in
`lib/server/support-boundaries.test.ts` asserts that neither the route nor the
verifier mentions `organizationProducts` again.

### The picker reads a search endpoint, not the catalogue endpoint

`GET /api/v1/support/products?q=` — new, deliberately narrow:

- scoped to the caller's organization from the session, no parameter for it;
- returns `id`, `productCode`, `name` and nothing else. In particular **no
  price** — `lib/price-visibility.ts` governs who sees prices and a picker has
  no business carrying one;
- bounded at 20 results, with the query trimmed and length-capped;
- rate limited as `search`.

The existing `/api/v1/inventory/organization-products` was rejected for this: it
returns the whole catalogue with pricing fields and is cached per role, which is
far more than a picker needs and more than a requester should receive.

### Where the product shows

| Surface | Shown as |
|---|---|
| Raise-a-query dialog | select-styled searchable panel, under Category; required unless the category is Other |
| Thread list row | `Product <code>` beside the order chip |
| Thread detail card | an "About product" row, code and name |

Not the notification email: it does not cite the order either, and widening what
leaves the system by email is a separate decision.

## Files

| File | Change |
|---|---|
| `lib/support-thread.ts` | retired/selectable category lists, `isProductRequiredForCategory` |
| `lib/support-thread.test.ts` | the two lists agree; which categories need a product |
| `lib/server/mutation-validation.ts` | create accepts selectable only, plus `productId`, and enforces the requirement |
| `lib/server/support-thread-validation.test.ts` | what the endpoint accepts at its boundary |
| `db/schema.ts` + `drizzle/` | `support_threads.product_id` |
| `lib/server/support-threads.ts` | `verifyProductReference`, product on read and write |
| `app/api/v1/support/products/route.ts` | new search endpoint |
| `lib/server/support-boundaries.test.ts` | new route joins `SUPPORT_ROUTES` |
| `components/support/product-picker.tsx` | new combobox |
| `components/support/new-thread-dialog.tsx` | category list + picker |
| `components/support/support-list.tsx` | product on the row |
| `components/support/support-thread-view.tsx` | product on the detail card |

## Security impact

- New read endpoint: authenticates, checks `isSupportParticipantRole`, rate
  limits, scopes to the session's organization, returns three non-sensitive
  fields, bounded at 20. Added to the contract test's route list.
- New write field: an id only, validated against the author's organization
  server-side. Cross-tenant citation is refused, and refused identically to a
  non-existent id so the endpoint cannot be used to enumerate another tenant's
  catalogue.
- No price data is added to any support response.
- The "a product is required" rule is validation rather than authorization, but
  it is still enforced server-side: the dialog can be bypassed, and a thread
  with no product under a product category is a support burden, not a breach.

## Database impact

One additive migration: a nullable `product_id` column with an index and a
`SET NULL` foreign key. No backfill, no rewrite, no lock of consequence.
Rollback is dropping the column; existing rows are unaffected because the
column is nullable and every read tolerates null.
