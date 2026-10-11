# OF-KE — Reattribute imported orders from placeholder accounts to their person

## Problem

A K-Electric user reported that a legacy order (invoice `517/JUL/APR/2026`,
Marcomm, 29 Jul 2026) "is not in OneFlowe". It is: order 1722,
`KE-LEGACY-1333`. They cannot see it because:

- the Order Portal reads only orders the viewer **created**, at the viewer's
  own branch (`addOrderRoleConditions` in `app/api/v1/orders/route.ts`,
  `canOrderPortalReadOrder` in `lib/group-order-visibility.ts`);
- the order importer found no matching account when it ran, so it attributed
  the order to a synthetic placeholder (`legacy_ke_loc166_user196`,
  `@historical.invalid`, inactive). `sync:ke` later created the person's real
  account (`tanveer-10058-op`), but nothing moved their history to it.

59 imported org-10 orders sit on an inactive creator. This is the WS9
"placeholder-attributed orders" decision left open in
`plans/OF-KE-PARITY-production-legacy-reconciliation.md`.

## Decision: move only what the data proves

An order moves from its creator to an active account only when **all** of
these hold. Every order that fails a rule is held, with the rule named, and
nothing is written for it.

1. **The current creator is a placeholder, not a person**: username
   `legacy_ke_*`, email `@historical.invalid`, no `external_source`. The 30
   orders on the retired `checking-<code>-*` accounts are **not** moved. Those
   accounts belong to the previous holders of the seven reissued login codes
   (`KE_LOGISTICS_RETIRED`). The name recorded on each of those orders follows
   the import batch, not the order date: every order imported on 12 Jul carries
   the previous holder's name, and every one imported later carries the new
   holder's. So the name may be the login's name at import time, and the person
   who placed the order cannot be established. The legacy API is offline
   (404), so it cannot settle the question either.
2. **The order is at the branch legacy named**: the order's branch is pinned
   (`external_source = 'KE_LOGISTICS'`) to the legacy `LocationID` recorded in
   `legacy_order_imports.source_payload`.
3. **The legacy login has one name throughout**: every imported order with the
   same legacy `OrderTakerID` records the same name. A login that changed hands
   is held.
4. **The placeholder is that person**: its own name equals the legacy name.
5. **Exactly one target**: one active, non-deleted, `ORDER_PORTAL`,
   `KE_LOGISTICS` account **at the order's branch** whose name equals the legacy
   name. Names are compared with `normalizeLegacyText` (case, punctuation and
   spacing only: `Muhammad Tahir .Shafi` = `Muhammad Tahir Shafi`). An account
   with the name at another branch does not qualify. An Order Portal user
   cannot see an order at another branch, and a branch move is not this
   script's to make.

Against production on 2026-10-08 this moves 16 orders for 8 people and holds
43:

| held | orders | why |
|---|---|---|
| reissued-code accounts | 30 | rule 1 |
| `Head Office K-Electric` placeholders | 7 | no person of that name |
| `test branch` placeholder | 3 | no person of that name |
| SHOAIB UR REHMAN (Payroll & Funds) | 1 | the person's account is at a different branch |
| Muhammad Nabeel Noor at Cluster Johar | 1 | the person's account is at Johar Technical |
| tariq.shan at `society cluster` | 1 | the person's account is at the twin `Society Cluster` |

## What is written

Per moved order: `orders.created_by_user_id` and `updated_at`, guarded by
`id`, `tid`, `organization_id = 10`, `branch_id` and the previous creator.

Per placeholder whose every order moves: its `legacy_user_mappings` row (same
legacy taker, same branch) points at the person, with `is_synthetic = false`.
Otherwise a re-run of the importer would file new orders from that login on
the placeholder again.

One `audit_logs` row, `KE_ORDER_CREATOR_REPAIR`, listing every move.

**Not touched:** totals, items, status, branch, budgets (keyed by branch), the
quantity ledger, stock, receipts (`receipt_data.buyerName` is the branch
name), invoice numbers, notifications, and the placeholder accounts
themselves, which stay inactive.

## Effect on the people moved to

Each sees their own history in the Order Portal, can download those invoices,
and can hand over the fulfilment token on an order still `APPROVED` /
`DELIVERED` (1897, 1978, 1753), which is the intended owner's action. The
budget-burn watchlist attributes these orders to the person instead of an
inactive placeholder. Branch Admin and Head Office see no change.

## Safety

- Dry run by default. Commit requires the organization confirmation, the
  plan digest and the expected move count.
- The commit re-plans from rows read inside the transaction, after
  `pg_advisory_xact_lock(700012)`, the lock shared with
  `repair-ke-order-branches` and `regenerate-usernames`. It locks the moved
  orders, the mapping rows and the involved accounts. A digest mismatch writes
  nothing.
- Protected fingerprints (org-10 order count, totals, refunds, items, status
  mix, every budget row, other tenants' orders) must be identical after.
- Org 2 (K-E-Demo) shares people's emails. Every statement carries
  `organization_id = 10`, and nothing matches by email.

## Rollback

`--rollback=<commit report> --confirm-rollback=ROLLBACK:<auditLogId>:KE-ORDER-CREATOR-REPAIR`
restores each creator and mapping row, only where it still holds what the
repair wrote, and writes `KE_ORDER_CREATOR_REPAIR_ROLLBACK`.

## Tests

`lib/legacy-import/ke-order-creators.test.ts` covers each move rule and each
hold, including the production shapes above. The script is rehearsed as dry
run → commit → rollback against a non-production database before it runs on
production.
