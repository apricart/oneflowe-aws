# Live product-duplicate consolidation investigation

## Executive conclusion

Do **not** delete, deactivate, or directly reassign the suspected duplicate products through the existing product APIs. The safe operation is a purpose-built, transactional **product consolidation** that preserves order snapshots, reconciles every organization-specific assignment, retargets K-Electric legacy mappings, and archives rather than physically deletes the old product rows.

An absolute zero-change merge is not possible for every candidate in the current data. Some alleged duplicates are simultaneously active inside the same organization at different prices. One product cannot retain two organization-level prices after the rows become one, because `organization_inventory` is unique by organization and global product. Stock is also stored globally, not per organization. Those price and stock decisions must become explicit preflight blockers; the system must never guess.

The attainable guarantee is:

- no lost orders, refunds, invoices, tax, quantities, budgets, assignments, support history, or import lineage;
- no change to financial totals for any organization, branch, user, status, or period;
- no change to another organization's catalogue state or negotiated price;
- historical order and invoice descriptions remain exactly as issued;
- duplicate product dimensions intentionally collapse into the approved canonical product in product-level reports;
- current price, visibility, and stock change only when an owner has explicitly approved an otherwise unavoidable conflict.

## Evidence scope

- Repository commit: `35f4242df63c6067a7dd878c7b2a9b0631cd7f2c`
- Live database snapshot: `2026-09-14T15:42:26.472Z`
- Transaction mode: `REPEATABLE READ`, `READ ONLY`
- Candidate source: the previously reviewed workbook containing 18 imported-versus-existing pairs and 13 imported-versus-imported pairs.
- No production data was changed.

## Live impact found

The 31 reviewed pair findings touch 51 distinct product rows. Those rows currently span:

- 85 organization-inventory rows across K-E-Demo, UBL, EFU, and K-Electric;
- 3,193 branch-inventory rows;
- 38 K-Electric legacy product mappings;
- 27 rows in the parallel `organization_products` model;
- two support threads, both on non-retire-side products;
- one historical product-import batch whose JSON list contains some candidate IDs.

There are currently no candidate rows in group prices, quantity budgets, quantity-budget allocations, restock requests, product modifiers, `branch_products`, or product-assignment history. A production implementation must still support or block those relationships because they can appear before a future merge is executed.

### Confirmed first wave

The confirmed consolidation plan has 11 clusters and would archive 12 duplicate global-product rows:

`182, 190, 202, 209, 225, 227, 253, 259, 263, 267, 340, 341`

Those retire-side rows currently have:

- 15 organization-inventory rows across K-E-Demo, UBL, and K-Electric;
- 703 branch-inventory rows;
- 1,298 order-item rows, all in K-Electric;
- 13 legacy mappings;
- 10 `organization_products` rows;
- PKR 4,875,721 of gross order-line history.

Of the 1,298 order lines, 1,182 are fulfilled, five are refunded, and **111 belong to approved, nonterminal unpaid orders**: 59 in process, 45 not started, and seven out for delivery. Approved orders may still be deleted by the admin workflow, which restores stock using the product ID stored on the order item. This is a direct reason not to retire the source IDs before their order references and stock behavior are reconciled.

### Cross-organization exposure

The canonical products are already used by other organizations. In addition, imported candidates 202 and 263 have active UBL organization-inventory rows, although those two rows currently have no UBL branch assignments or UBL orders. Candidate 182 has a K-E-Demo organization row without branch or order usage.

More importantly, ambiguous candidates must not be included automatically:

- Product 186 (`Nestle Everyday 1kg`) has 22 UBL order lines and 24 UBL branch rows, in addition to heavy K-Electric use.
- Toshiba-related candidates are used by K-E-Demo, UBL, and K-Electric.
- The 95 g versus 100 g Nescafe pair and generic-versus-sized Olpers pair are different SKUs unless external evidence proves a pack replacement.

Only approved, exact-identity clusters should enter a merge plan.

## Why the existing delete behavior is unsafe

1. `global_products` is a shared master catalogue. A product is not owned by K-Electric merely because K-Electric imported or mapped it.
2. The current admin delete endpoint marks the global product inactive/deleted and then calls the global status cascade. That cascade changes every active `organization_inventory` row and every live branch row for the product. A shared product can disappear for unrelated tenants.
3. The product update and cascade writes are not wrapped in one database transaction, so an intermediate failure can leave partially changed global, organization, branch, or audit state.
4. A second product endpoint has a different delete behavior: it only sets the global status to inactive. The two APIs therefore do not implement one safe retirement rule.
5. Soft deletion does not retarget orders or legacy mappings. Product reports group and filter by `order_items.global_product_id`, so the old and new IDs remain separate.
6. The K-Electric sync reads `legacy_product_mappings` as its source of truth. If a mapped legacy-owned product is merely made inactive, the sync can reactivate it. If it is soft-deleted, the sync plans an activation but its guarded update refuses the deleted row and can fail the sync.
7. `organization_inventory` has cascading children. Deleting one before moving branch inventory, group prices, and quantity budgets can delete operational and reporting state.

## Data-model hazards that a merger must handle

The live database has 16 foreign keys into `global_products` or `organization_inventory`.

Direct global-product relationships include order items, organization inventory, organization products, branch products, product assignments, restock requests, product modifiers, quantity budgets, quantity-budget allocations, legacy mappings, and support threads. Most use `NO ACTION`; support threads use `SET NULL`.

Organization-inventory relationships include branch inventory, group prices, quantity budgets, quantity-budget allocations, and legacy mappings. Several use `ON DELETE CASCADE`.

`order_items.organization_inventory_id` is indexed but has **no foreign key**. Every merge must explicitly prove that each order item's organization, global product, and organization-inventory row still agree.

Unique indexes create collision cases that cannot be handled with a bulk ID update:

- one organization-inventory row per `(organization, global product)`;
- one branch-inventory row per `(branch, organization inventory)`;
- one organization-product row per `(organization, global product)`;
- one branch-product row per `(branch, global product)`;
- one group price per `(group, organization inventory)`;
- one quantity budget per `(branch, organization inventory, period)`;
- one product-modifier link per `(product, modifier)`.

## Current conflicts that require decisions

### Price

The confirmed Sugar cluster demonstrates why an automatic merge cannot promise zero operational change:

- K-Electric duplicate organization item 192 is priced at PKR 155; canonical organization item 268 is priced at PKR 195.
- The duplicate is active and visible at 56 K-Electric branches; the canonical row is also present at many branches, with 32 branch collisions.
- K-E-Demo also has both organization rows at PKR 60 and PKR 200, although the duplicate currently has no branch assignment there.

The 200 g Nescafe cluster also contains a later sync row at a PKR 2,100 global price and an established K-Electric organization row at PKR 3,800. The newer row is active at one branch.

Because there is no branch-level price tier, one canonical organization row cannot preserve two simultaneous prices for the same organization. The merge must block until an owner chooses the correct current price, or the application introduces a genuine branch-level pricing tier.

Historical prices are safe: `order_items.price_cents`, tax, name, code, and unit are snapshots and must not be rewritten.

### Stock

`global_products.stock_quantity` is the stock source used by all organizations. Orders decrement it directly. The K-Electric sync can also replenish a mapped product when its stock is zero. Merging a K-Electric product into a canonical product shared by UBL or EFU therefore combines their future demand against one stock counter and can let the legacy sync touch shared stock.

Do not sum duplicate stock automatically: the legacy sync seeded many imported rows with 500, so addition can double-count physical inventory. Do not take the minimum or canonical value automatically either, because that can remove legitimate sellable capacity. Require a verified stock value and modify the K-Electric sync so it cannot set stock on a shared, non-legacy-owned canonical product. If inventory is intended to be organization-specific, stock must move out of `global_products` into an organization/warehouse inventory table before consolidation.

## Recommended lossless consolidation design

### 1. Add a permanent merge ledger and alias

Add a merge-event table and an alias table, for example:

- `product_merge_events`: event ID, actor, reason, status, plan digest, preflight snapshot, started/applied/rolled-back timestamps;
- `global_product_aliases`: retired product ID (unique), canonical product ID, merge event ID, creation timestamp.

The alias must reject self-links and cycles. Old product IDs should resolve to the canonical ID in admin links, saved filters, APIs, and operational stock restoration. The duplicate `global_products` row remains as an archived tombstone; it is never physically deleted and its code is never reused.

### 2. Build a dry-run planner, not a one-off SQL script

For every cluster, the planner must emit:

- canonical and retire IDs;
- every organization and branch affected;
- effective price, active/visible state, category, unit, tax, discount, image, quantity step, and stock differences;
- order counts by status, refunds, support threads, mappings, budgets, allocations, modifiers, and JSON audit references;
- all uniqueness collisions and the proposed survivor row;
- a cryptographic plan digest.

The commit must require the same digest, explicit organization/product confirmations, an active Super Admin actor, and a recent production backup.

### 3. Use one guarded transaction

Run the apply operation in a maintenance window using a serializable transaction and an advisory lock. Lock all member products and affected organization-inventory rows in a stable ID order. Recheck that product timestamps, prices, stock, assignments, order counts/statuses, and mappings still match the approved plan. Any drift or row-count mismatch rolls back the entire cluster.

Apply one cluster at a time. This gives a precise blast radius and a usable rollback point.

### 4. Preserve organization rows whenever possible

For an organization that has only the retire-side organization-inventory row, change that row's `global_product_id` to the canonical ID. Its organization-inventory ID, price, name overrides, branch rows, group prices, and budgets remain stable.

When both organization rows exist:

1. keep the canonical organization-inventory row;
2. block on different effective prices or conflicting descriptive settings unless the owner approved a resolution;
3. create/restore canonical branch rows using the approved visibility state;
4. reparent order-item organization-inventory IDs, group prices, budgets, and allocations;
5. archive the duplicate branch and organization rows only after every child is accounted for.

Never delete an organization-inventory row and rely on `ON DELETE CASCADE` during consolidation.

### 5. Consolidate historical reporting by ID while preserving snapshots

Update affected `order_items.global_product_id` to the canonical product and `organization_inventory_id` to the surviving organization row. Do **not** change order-item IDs, names, codes, units, quantities, unit prices, tax, or timestamps. Do not rewrite `orders.receipt_data`; it already contains issued descriptions and financial snapshots. Refund items continue to point to the same order-item IDs.

This approach makes the existing product reports aggregate under the canonical ID without changing monetary arithmetic. Some analytics display the current global product name after joining by ID, so their label will intentionally become the canonical name; invoice and itemized snapshot descriptions remain unchanged.

### 6. Reconcile every remaining relationship explicitly

- `legacy_product_mappings`: point every legacy spelling to the canonical product and surviving K-Electric organization item. Multiple legacy names mapping to one row is already supported and deduplicated by the branch-catalogue planner.
- `organization_products` / `branch_products`: update when no collision; otherwise merge enabled/state/custom fields using explicit rules and archive the losing row.
- group prices: move when unique; if both sides exist with different prices, block.
- quantity budgets: move when unique. If both sides exist for the same branch and period, sum allocated/held/used/credited values and financial allocation values, reparent allocation rows, and revalidate the budget invariant before removing the losing row.
- product modifiers: union links; reject incompatible required/default semantics.
- open restock requests and support threads: retarget to the canonical ID; retain their text and history.
- product assignments, audit-log JSON, sync-log JSON, and product-import batch JSON: preserve as historical facts. The alias and merge ledger explain the old IDs.

### 7. Archive last

Only after all counts reconcile:

- set the duplicate global row inactive and soft-deleted;
- record `mergedIntoProductId` and the merge-event ID in metadata;
- ensure no active organization or branch assignment remains on it;
- invalidate global, organization, branch-inventory, report, and product-list caches after commit.

## Required validation gates

Compare pre- and post-merge results for every affected organization and branch:

1. identical order count and order-item ID set;
2. identical totals for quantity, gross, tax, refunds, order subtotal, and order total by day/month/status;
3. identical invoice/receipt snapshot hashes;
4. identical user, branch, organization, group, and executive-report totals;
5. product report totals equal, with only the approved product rows collapsed;
6. no order item whose organization-inventory row belongs to another organization or points to another global product;
7. identical quantity-budget availability and allocation totals;
8. identical effective price and visibility for every unaffected branch;
9. no change at all in a control set from organizations outside the cluster;
10. every legacy normalized name resolves to the canonical K-Electric organization item;
11. a K-Electric sync dry run proposes no re-creation/reactivation of retired products;
12. zero remaining active references to a retired ID, except immutable audit/history JSON covered by the alias ledger.

Run the entire transaction against a restored production clone first, execute the real report endpoints before and after, and rehearse rollback. Production commit should be followed immediately by the same validator.

## Rollout recommendation

1. **Stop manual deletion of candidate products.** Mark the workbook decisions only; do not call either existing delete API.
2. **Approve identities and commercial choices.** Start with the confirmed clusters, but separately resolve Sugar and the later 200 g Nescafe price conflict. Leave all “Likely” and “Needs review” pairs untouched.
3. **Implement the merge ledger, planner, transaction, validator, rollback, old-ID resolver, and sync guard.** Add tests for every unique-collision path and cross-tenant isolation.
4. **Rehearse on a current production clone.** Require report parity and exact row-count checks.
5. **Drain or explicitly migrate nonterminal orders.** The confirmed retire IDs currently have 111 approved nonterminal lines. If they are migrated, ensure later admin deletion restores stock to the canonical ID.
6. **Apply one low-risk confirmed cluster first.** Choose a cluster with no organization/branch collision and matching price semantics, validate all tenants, then proceed cluster by cluster.
7. **Prevent recurrence.** Product creation, CSV import, legacy import, and full sync should show/block strong near-duplicate candidates and require an explicit reuse/create decision. Product code remains unique, but code-only matching is insufficient. Do not impose a fuzzy-name unique constraint; legitimate sizes and variants exist. Prefer GTIN/vendor SKU plus normalized brand, variant, size, unit, and pack fields with human review.

## Final recommendation

Treat this as master-data consolidation, not cleanup. The correct target is a reusable, audited merge capability with strict preflight blockers. The current live data is suitable for a staged first wave after the Sugar/Nescafe price decisions, stock semantics, and 111 nonterminal order lines are resolved. Until those conditions are met, deletion would create a higher reporting and cross-tenant risk than leaving the duplicates visible.
