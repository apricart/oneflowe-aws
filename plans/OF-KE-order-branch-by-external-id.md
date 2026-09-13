# OF-KE — Resolve imported order branches by legacy id, and move the two misplaced orders

## Problem

`scripts/import-ke-orders.ts` (`buildPlan`) keyed K-Electric branches by
`normalizeLegacyText(branch.name)` — lowercase, punctuation stripped — and never
looked at `branches.external_id`, even though every prepared order carries the
legacy `LocationID` (`PreparedApiOrder.legacyLocationId`). `Johar |` and
`Johar ||` both normalise to `johar`; `society cluster` and `Society Cluster`
collide the same way. The `Map` kept whichever row was read last, so an order
for the *other* twin landed on the wrong branch.

Verified read-only on production (2026-09-12, re-checked 2026-09-13): exactly 2
of the 943 K-Electric orders sit on a branch whose `external_id` differs from
the legacy `LocationID` in their own `legacy_order_imports.source_payload`:

| Legacy order | OneFlowe order | Amount | Sits at | Legacy says |
|---|---|---|---|---|
| 1472 | 2016 (`APPROVED/IN_PROCESS`, 2026-08) | Rs 36,970 | `Johar \|\|` (244, ext 147) | `Johar \|` (243, ext 146) |
| 2519 | 1993 (`FULFILLED/DELIVERED`, 2026-09) | Rs 34,675 | `society cluster` (226, ext 128) | `Society Cluster` (279, ext 132) |

Organization totals are unaffected, which is why org-level reconciliation
passed. Branch dashboards, branch order lists and branch budget spend/holds are
wrong for those four branches: `backfill-ke-budget-spend.ts` charged Johar ||
2026-08 (held 3,697,000, allocation raised to match) and society cluster
2026-09 (spent 3,467,500) for orders that belong to their twins.

The CLAUDE.md rule "branches are matched by `external_id`, never by name once
pinned" was implemented in `sync-ke.ts` only; the order importer predates it.

## Change

### 1. `lib/legacy-import/ke-order-branches.ts` (new, pure)

- `indexBranches(branches, source)` / `resolveLegacyBranch(index, order)`:
  a branch pinned to the order's `legacyLocationId` wins outright; the name
  fallback considers **unpinned** branches only (production has one); a name
  that matches only a branch pinned to a *different* legacy id is
  `NOT_FOUND` with a detail that names the collision, never a match; two
  candidates are `AMBIGUOUS`.
- `planOrderBranchRepair(...)`: for every imported order whose branch
  `external_id` disagrees with its recorded legacy `LocationID`, plan the move,
  re-attribute the creator, and recompute the affected branch/month budget
  rows with the same accounting `backfill-ke-budget-spend.ts` uses
  (fulfilled = spent, pending/approved = held, net of refunds; allocation is
  raised to satisfy `budgets_values_valid_ck`, never lowered). Recomputing the
  *whole* key from the post-move order set — rather than adding and
  subtracting one order — is what lets a source row go back to zero, which
  the backfill cannot do because a branch/month with no orders produces no
  consumption row.
- Creator rule, mirroring the importer: same legacy identity (`external_id`)
  at the target branch if one exists (active first); otherwise a personal
  account is kept (a person may hold one account elsewhere, as the importer
  allows); a creator with no legacy identity was the *branch's* fallback
  account, so it is re-attributed to the target branch's own order-portal
  account, or held if the target has none.
- Orders whose import payload predates the `sourceHeader.LocationID` shape
  (21 in production) are listed as unverifiable, not moved.

### 2. `scripts/import-ke-orders.ts`

`buildPlan` selects `external_source, external_id` and resolves through the
module. New reject reason `BRANCH_AMBIGUOUS`. Nothing else in the importer
changes; `legacyLocationId` was already on the prepared order.

### 3. `scripts/repair-ke-order-branches.ts` (new)

Same shape as `resync-ke-order-status.ts`: dry-run default that writes a
report and prints the digest; `--commit` requires
`--confirm-organization=10:0001:K-Electric`, `--confirm-plan-sha256`,
`--expected-moves`, `--operator`; one transaction under an advisory lock,
plan rebuilt from rows read under the lock and compared to the digest, guarded
`UPDATE ... WHERE` on every row, `audit_logs` row, tenant fingerprints before
and after, cache prefixes invalidated. `--rollback=<report>` reverses it with
the same guards.

Per move: `orders.branch_id`, `orders.created_by_user_id` (when re-attributed),
`receipt_data.buyerName` / `buyerAddress`, `updated_at`; then the recomputed
`budgets` rows (UPDATE or INSERT). Never `total_cents`, `order_items`, stock,
quantity budgets, invoice sequences, or email.

### 4. Docs

CLAUDE.md K-Electric section gains the rule; the memory note is updated once
the repair has been committed.

## Tests

`lib/legacy-import/ke-order-branches.test.ts`: pinned match beats name; twin
collision is refused with the collision named; unpinned name fallback; ambiguity;
repair plan for the two real shapes (personal account kept, branch fallback
re-attributed, held order, spent order, source row zeroed, target row inserted
with allocation raised, unchanged rows omitted, unverifiable listed); digest
stability.

## Security / tenant impact

Scripts only; no route or permission change. Every statement carries
`organization_id = 10`; other-tenant fingerprints are asserted unchanged. No
PII in reports beyond usernames already present in earlier repair reports.

## Database impact

No schema change. Two `orders` rows updated, four `budgets` rows touched
(two updated, up to two inserted). Rollback via `--rollback` with the committed
report; audit rows are append-only.

## Rollout

1. `npm test`, `npm run typecheck`, `npm run lint`.
2. `npx tsx scripts/repair-ke-order-branches.ts` (dry run) — expect 2 moves.
3. Commit with the printed arguments. Confirm Johar || and Society Cluster on
   the Orders page against the legacy portal.
4. Future `import:ke-orders` runs resolve by `external_id`; the collision can
   not recur for pinned branches.
