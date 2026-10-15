# OF-WAREHOUSE — The whole product catalogue, read-only, for the warehouse

Supersedes D2 and D3 of `plans/OF-WAREHOUSE-read-only-product-catalog.md`
(global catalogue only; no price anywhere). D1 (a section of the warehouse
workspace with its own GET-only endpoints, never the admin `/inventory` pages)
and D5 (images only from the bucket) stand.

## Requirement (product owner, 2026-10-13)

- Replace the single Product Catalog tab with Super Admin's Product Catalog
  menu, the same seven sub-menus in the same order: Global Products, Product
  Price History, Organization Products, Group Products, Categories,
  Subcategories, Product Requests.
- **Read-only.** The warehouse must not be able to create, edit, delete,
  assign, activate, price, raise or decide anything there.
- **Prices shown as Super Admin sees them** (asked and answered: "Show prices
  like Super Admin").
- **Tenant menus only for organizations the warehouse serves** (asked and
  answered: "Only orgs it serves").

## Decisions

- **D1 — Own endpoints, GET only.** Seven views, each read through a
  `/api/v1/warehouse/catalog/*` handler that exports `GET` alone and checks
  `requireApiRole(["WAREHOUSE"])` itself; the proxy allowlist admits `GET`
  alone. Super Admin's endpoints (`/admin/global-inventory`,
  `/admin/organization-assignments`, `/head-office/branch-assignments`,
  `/admin/product-price-history`, `/product-requests`, `/categories`,
  `/subcategories`) stay closed to the role: each also writes, and reusing
  their pages with buttons hidden would be presentation, not a control.
- **D2 — The fence.** Global Products, Categories and Subcategories are
  Apricart's own catalogue: no tenant fence. Organization Products, Group
  Products, Price History and Product Requests are fenced to the organizations
  of the branches in `loadWarehouseReach` (branch or city), re-read every
  request (`loadWarehouseCatalogFence`). Another organization, or a group of
  another organization, is **404**. Price History: the global tier, plus
  organization and group rows of served organizations; branch options and
  branch rows only for the warehouse's own branches.
- **D3 — Prices.** Base, organization, group and effective prices, and the
  product request's expected price, are returned. Effective prices go through
  `resolveEffectivePriceCents` / `scopedOverrideCentsSql` — never a hand-written
  fallback. No tax rate or discount is selected (Super Admin's lists show
  neither).
- **D4 — No people.** As on every warehouse read, no requester, reviewer or
  assigner is named — Product Requests omits Super Admin's "Requested by"
  column. Free text (reference URL, notes) is rendered as text, never a link.
- **D5 — Price History reuses the logic, not a copy.** The body of
  `app/api/v1/admin/product-price-history/route.ts` moved unchanged into
  `lib/server/product-price-history.ts` (`loadProductPriceHistory`), taking an
  explicit access (`SUPER_ADMIN` | `HEAD_OFFICE` | `WAREHOUSE`). The admin route
  keeps its behaviour and response; `tests/integration/product-price-history-api.test.ts`
  still passes unchanged. The view component takes an `endpoint` prop.
- **D6 — Menu.** "Product Catalog" is a collapsible group in the warehouse side
  menu with the seven items; each is a hash section (`#catalog`,
  `#catalog-price-history`, …), so an old `#catalog` link opens Global Products.

## Files

- `lib/warehouse-catalog.ts` — parsers for the new queries (unknown keys refused, lists bounded).
- `lib/server/warehouse-catalog.ts` — base price on Global Products; `listWarehouseTaxonomy`.
- `lib/server/warehouse-catalog-tenant.ts` — fence, Organization Products, Group Products, Product Requests.
- `lib/server/product-price-history.ts` — the shared loader.
- `app/api/v1/warehouse/catalog/{taxonomy/categories,taxonomy/subcategories,organizations,organization-products,group-products,price-history,product-requests}/route.ts`.
- `components/warehouse/catalog/*` and `components/warehouse/warehouse-workspace.tsx`.
- `lib/warehouse-access.ts` — allowlist.

## Tests

- `lib/warehouse-access.test.ts` — allowlist (GET admitted, every write verb and
  Super Admin's endpoints refused), handlers export GET alone, tenant handlers
  call the fence, the reads contain no insert/update/delete, no person named,
  no catalogue view calls anything but its own GET routes or carries a form.
- `components/warehouse/catalog/catalog-views.test.tsx`, `warehouse-workspace.test.tsx`.
- `tests/integration/warehouse-catalog-full.test.ts` — role matrix (401/403),
  fence (served vs not, empty reach), ladder prices, cross-tenant group,
  price-history options and points, malformed queries (400).
- The isolation and write sweeps cover the new handlers automatically.

## Security impact

Widens what the warehouse reads: customer prices and price history, and
product requests, for the organizations it already serves. It writes nothing
new — no write method exists on any catalogue handler. No migration.

## Rollback

Revert. No data changes.
