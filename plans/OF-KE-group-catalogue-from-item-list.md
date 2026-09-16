# OF-KE — Make one item list live at every branch of chosen K-Electric groups

## Problem

K-Electric handed over `Item List (7).xls` — 121 rows, 120 distinct products,
all already in the catalogue and all assigned to the organization — with the
instruction that every one of them is to be orderable at every branch of the
**Enabling**, **Tranmission** (sic) and **Generation** groups.

A read-only check on 2026-09-15 found 388 product × branch gaps across the 53
branches of those groups:

| Group | Fully live products | Cells | Live | Dormant row | No row |
|---|---|---|---|---|---|
| Generation (5 branches) | 119 / 120 | 600 | 595 | 0 | 5 |
| Tranmission (17) | 108 / 120 | 2,040 | 1,982 | 17 | 41 |
| Enabling (31) | 61 / 120 | 3,720 | 3,395 | 34 | 291 |

Two causes. The current state mirrors the legacy per-location item lists
(`sync:ke` does exactly that, and never hides), so a product legacy does not
list at a location has no row there. And 51 rows are *dormant* —
`is_visible = false AND is_active = false`, all dated 2026-07-12 — because
the legacy order import created them so historical order lines would resolve.

Neither can be fixed from the UI: the Group Inventory "Assign to Group"
endpoint skips any existing row, visible or not
(`app/api/v1/head-office/branch-assignments/route.ts`, `activeKeys`), and the
"Activate / Deactivate" tab toggles the organization entry, not a branch row.

## Change

A dedicated script, not a `sync:ke` mode: the sync mirrors the legacy
platform, and this deliberately goes past it — a list a person handed over,
applied to groups a person named. It writes **branch rows only**. The product,
the organization entry, the price and the stock are left exactly as they are.

### 1. `lib/legacy-import/ke-group-catalogue.ts` (new, pure)

- `planGroupCatalogue(wanted, mapped, branches, assignments)` — for every
  distinct product on the list × every **active** branch of the chosen groups:
  a visible, active, non-deleted `branch_inventory` row is `unchanged`; a
  missing row is a `CREATE`; a row in any other state (hidden, inactive, or
  soft-deleted) is a `RESTORE`, and the plan records the row's before-state so
  the run can be reversed.
- Names resolve through `legacy_product_mappings` — the sync's own join key
  (`normalizeProductName`) — never by fuzzy matching. A name with no mapping is
  `PRODUCT_NOT_MAPPED`; one mapped to two products is `PRODUCT_AMBIGUOUS`; a
  retired product is `PRODUCT_RETIRED`; an inactive organization entry is
  `ORGANIZATION_ENTRY_INACTIVE`. Every one of those is reported and skipped —
  the script never creates a product or an organization assignment. On the
  2026-09-15 list every name resolves to one active, assigned product.
- Two list names that resolve to one product (a spelling variant, a merged
  duplicate) plan that product once.
- A product with no stock is reported as a warning: the row will exist but
  `POST /api/v1/orders` refuses a line above `stock_quantity`. Stock is the
  sync's job (`sync:ke --stock`).
- An inactive branch is reported and skipped, never assigned.
- `planGroupCatalogueReversal(committedAssignments, currentAssignments)` — from
  a commit report: a `CREATE`d row is deleted, a `RESTORE`d row is put back to
  its recorded before-state, in each case only if the row still holds what the
  run wrote; anything that moved since is reported, not overwritten.
- `groupCataloguePlanLines` / `groupCatalogueReversalLines` — the sorted lines
  the digest is taken over.

### 2. `scripts/assign-ke-group-catalogue.ts` (new)

`npm run assign:ke-group-catalogue -- --sheet=<xls> --groups=<name,name,…>`

- Dry run by default. `--commit` needs `--actor-user-id` (active
  `SUPER_ADMIN`), `--confirm-organization=<id:code:name>` and
  `--confirm-plan=<digest>`; `--rollback-test` applies inside a transaction
  and rolls back. `--reverse=<commit report>` reverses a committed run, gated
  the same way.
- `--groups` is required and matched by exact name within the organization —
  a run is never allowed to default onto the Distribution group, whose
  locations legacy stocks with ~63 items by design.
- Organization by `--organization-code` (default `0001`), refused if the code
  belongs to a differently-named tenant, as the sync does.
- The plan is rebuilt under `pg_advisory_xact_lock(hashtext('oneflowe:ke-sync'))`
  from rows read there and its digest must match the confirmed one; the write
  is the sync's own upsert on `branch_inventory_branch_org_inventory_uq`;
  the run is recorded in `legacy_import_batches`; fingerprints prove no other
  tenant's rows and none of the organization's rows outside the chosen groups
  moved; a further plan after commit is empty; the `branch-inv` cache prefix
  is cleared so the shop lists the rows at once.
- The JSON report carries every row written with its before-state.

### 3. Tests

- `lib/legacy-import/ke-group-catalogue.test.ts` — the planner: create vs
  restore vs unchanged, before-state capture, list de-duplication, aliasing of
  two names to one product, every skip reason, zero-stock warning, inactive
  branch, group filtering (a branch outside the chosen groups is never
  planned), digest stability and sensitivity, and the reversal planner
  including "moved since" refusals.

## Security and tenancy

Every statement is scoped to the confirmed organization id; the upsert's
`organization_inventory_id` values come from `legacy_product_mappings` rows of
that organization, and the `branch_id` values from `branches` rows of that
organization in the named groups. No price column is touched. Fingerprints
cover every other tenant's `branch_inventory` and the organization's own rows
outside the chosen groups.

## Rollback

`--reverse=<commit report>`; dry run, digest-gated, refuses rows that changed
since. `branch_inventory` has no dependants, so deleting a created row is safe.

## Not in scope

Prices (two list prices differ from ours — Sugar and Millac whitener),
stock, the Distribution group, and any product not on the list.

## Addendum — 2026-09-15, Distribution and `--hide-others`

A second list, `Item List (8).xls` (63 products), is the Distribution
group's catalogue. Unlike the first run this list must also *exclude*: the
Distribution branches are to see the 63 and nothing else, while the other
three groups keep their 120. So the exclusion is per **branch row** at the
named groups' branches, never at the organization (which `restrict:ke-catalogue`
does, and which would have switched the products off for every group).

`assign:ke-group-catalogue` gained two things, both recorded for reversal:

- **Activation** of a listed product whose organization entry is off — that
  entry only; its branch rows elsewhere stay as they are, so a product switched
  off org-wide for the 120 and wanted back for Distribution reappears at
  Distribution alone. Three products on list 8 needed this (they were switched
  off by `restrict:ke-catalogue` batch `ea002e91` because list 7 lacked them).
- **`--hide-others`**: every fully live row at the named groups' active
  branches whose product is not on the list is set hidden + inactive, pinned
  to the live state the plan saw. Reversal shows it again if still hidden.

Committed as batch `4d777a68-cf71-447a-8e9b-568204af09d7`: 3 activated,
121 created, 165 restored, 252 hidden. Afterwards every Distribution branch
lists exactly 63 and every other branch exactly 120. Report:
`updatedReports/ke-group-catalogue-distribution-commit-2026-09-15.json`.
