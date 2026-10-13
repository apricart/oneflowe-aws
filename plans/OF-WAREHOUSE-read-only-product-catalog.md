# OF-WAREHOUSE — Read-only product catalogue for the warehouse

Builds on `plans/OF-WAREHOUSE-warehouse-fulfilment-role.md` (Phase 1), whose
Stock tab this replaces.

## Requirement

- Remove the warehouse's **Stock** tab.
- Give the `WAREHOUSE` role sight of the **product catalogue**, read-only: it
  creates, edits, deletes and assigns nothing.
- **No price is visible**: not the global base price, nor any tenant or group
  price, discount or tax rate.

## Decisions

- **D1 — A tab in the warehouse workspace, not the admin `/inventory` pages.**
  The role is kept outside the admin shell on purpose: those pages call
  Super-Admin endpoints that write products and return `basePrice`, and the
  shell's sidebar and context call endpoints the role may not reach. Opening
  any of them would widen `WAREHOUSE_API_RULES` to write-capable handlers.
  Instead `/warehouse` gets a **Product Catalog** tab with its own GET-only
  endpoints.
- **D2 — The global catalogue only.** What Super Admin sees under Global
  Products, Categories and Subcategories: Apricart's own catalogue, so no
  tenant fence applies. Organization Products, Group Products and Product Price
  History are per-tenant and price-bearing; Product Requests is a Head Office ↔
  Super Admin workflow. None of them is offered.
- **D3 — Prices are never selected.** The SQL names its columns; neither
  `base_price_cents`, `tax_rate_bp` nor any `discount_*` column is read, so no
  price is in the payload to hide (rule 09).
- **D4 — Stock stays visible as a column.** It was the Stock tab's whole
  content and is a column of Super Admin's Global Products; it is not a price.
- **D5 — Images only from the bucket.** A product's picture is returned only
  when it is an application path (`isStoredImagePath`), which the browser
  fetches from `GET /api/v1/images/products/<uuid>.<ext>`. That route is added
  to the allowlist as GET, pinned to the `products/` key shape — support
  attachments, desk screenshots and challans live under other prefixes the
  image route never serves. Legacy `data:` rows show a placeholder rather than
  inflate every page; `npm run migrate:images-to-s3` moves them.
- **D6 — The filter taxonomy is what the catalogue uses.** Category options
  are the subcategories referenced by a live global product, with their
  parents — never every row in `categories`, so a tenant-owned category that
  no global product carries is not named.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/v1/warehouse/catalog` | `{ items, total, page, limit, lowStockThreshold }` — id, code, name, unit, status, stock (+ low flag), image path, category, subcategory |
| `GET /api/v1/warehouse/catalog/categories` | `{ categories: [{ id, name, subcategories: [{ id, name }] }] }` |

Both: `requireApiRole(["WAREHOUSE"])`, `search` rate limit, unknown query keys
refused (400), page size bounded (default 50, max 200), `private, no-store`.
Filters: `q` (name/code, ≤ 100 chars, LIKE-escaped), `status`
(`active` | `inactive` | `all`, default `active`), `categoryId`,
`subcategoryId` (positive integers). Neither endpoint has a write method, and
the proxy admits GET only.

`GET /api/v1/warehouse/stock` and its module are removed — its one caller was
the Stock tab.

## Files

- `lib/warehouse-catalog.ts` (pure: query parsing, category labels) + test.
- `lib/server/warehouse-catalog.ts` (the two reads).
- `app/api/v1/warehouse/catalog/route.ts`, `.../catalog/categories/route.ts`.
- `components/warehouse/warehouse-catalog.tsx` + test; tab in
  `warehouse-workspace.tsx`.
- `lib/warehouse-access.ts` — rules swapped; image GET added.
- Removed: `app/api/v1/warehouse/stock/route.ts`, `lib/warehouse-stock.ts`,
  `lib/warehouse-stock.test.ts`, `lib/server/warehouse-stock.ts`,
  `components/warehouse/warehouse-stock.tsx`.

## Security

- Authorization: the role check is on each handler; the proxy allowlist is the
  second layer. Every other role is 403, including Super Admin (it has its own
  catalogue).
- Tenant isolation: only `global_products` and the categories it references
  are read; no `organization_inventory`, `branch_inventory` or group row.
- Writes: none exist. The contract test pins that the warehouse catalogue
  handlers export GET alone.
- Prices: absent from the SQL; integration tests assert the response carries
  no price field and not the seeded price value.

## Tests

- Unit: query parsing bounds and refusals; category labelling.
- Contract (`lib/warehouse-access.test.ts`): new paths admitted, stock path and
  non-product image prefixes refused, every warehouse handler still listed.
- Component: tab shows no price column and no create/edit/delete control.
- Integration (`warehouse-api`, `warehouse-security`): role matrix (401 / 403
  for every non-warehouse role / 200), no price in the payload, category and
  subcategory filters, unknown key → 400.

## Database impact

None. No migration.

## Rollback

Revert the change; the Stock tab and endpoint come back as they were.
