# K-Electric orders after 2026-07-10

This migration is fixed to organization `10:0001:K-Electric`. It imports only
legacy orders whose `OrderCreatedDT` date is strictly later than 2026-07-10.
Cancelled rows are never imported.

## Approved policy

- `Order Placed` (legacy `2/501`) -> `APPROVED / NOT_STARTED`.
- `InProcess` (`2/503`) -> `APPROVED / IN_PROCESS`.
- `Out For Delivery` (`2/506`) -> `APPROVED / OUT_FOR_DELIVERY`.
- `Delivered` (`2/507`) -> `FULFILLED / DELIVERED`.
- `Partial` (`2/505`) -> `FULFILLED / DELIVERED`.
- Legacy order 1327 (`1/501`) -> `FULFILLED / DELIVERED`, using its item
  subtotal of Rs. 14,980.00 with zero tax and charges because the source has no
  checkout row.
- The three zero-quantity/zero-value item artifacts are omitted.
- Operational approved orders receive approval tokens, migration approval
  provenance, and money-budget holds. Existing stock, branch inventory,
  quantity budgets, money spent, and invoice sequences are not changed.
- Source `UsedBudget` is evidence only. Attached `MonthlyBudget` and
  `AdditionalBudget` populate missing allocation rows; only the 48 operational
  order totals populate `amount_held_cents`.

## Current reviewed source

- Source manifest: `updatedReports/ke-post-cutoff-2026-08-07/source-manifest.json`
- Source digest: `21d4bc42da552ed21de7878e24761bd2b58c0a98591229879076ce4493c537fd`
- Spreadsheet SHA-256: `cc4e2e9f2794a81c4ce1ffb824949ca1dcfb914d2b4f2c995f4daf3a6e17a3e7`
- Budget attachment SHA-256: `f0c153171175838f1f5646eaff3a72d374aa9d14d5b41c12ee4767e98cabda01`
- Plan digest: `d5a88141a87144ec1eec8559f895760b577299963f516fe0a226c7025fd9e693`

The reviewed plan contains 111 orders (48 approved and 63 fulfilled), 1,302
items, one new branch, seven inactive historical users, one legacy product
mapping to existing PRD--93, 24 new budget rows, and 42 branch/month hold rows.
Its approved holds total Rs. 3,384,577.00. Its overall order total is
Rs. 6,168,643.00.

## Commands

Refresh the immutable source snapshot only when a new legacy export is supplied:

```powershell
npm run prepare:ke-post-cutoff -- "--xls=C:/path/Orders.xls" "--budget=C:/path/budget.json" "--output-root=updatedReports/ke-post-cutoff-2026-08-07"
```

Run the read-only preflight:

```powershell
npm run import:ke-post-cutoff -- --source-root=updatedReports/ke-post-cutoff-2026-08-07
```

Commit is intentionally not documented as a copy/paste command with a real
actor. Use an explicitly selected active global or K-Electric Super Admin and
every exact confirmation printed in `preflight.json`. The required flags are:

```text
--commit
--actor-user-id=<reviewed-super-admin-uuid>
--confirm-organization=10:0001:K-Electric
--confirm-source=<printed-source-digest>
--confirm-plan=<printed-plan-digest>
--expected-orders=111
--expected-approved=48
--expected-budget-inserts=24
--expected-historical-users=7
--allow-create-johar-technical
--allow-branch-identity-updates
--allow-historical-users
```

The rollback rehearsal report is
`backups/ke-post-cutoff-rollback-test-2026-08-07.json`. It inserted and
validated the complete plan, verified all generated tokens, simulated later
fulfilment of all 48 approved orders through their holds, proved stock and
quantity ledgers unchanged, and rolled the transaction back.

## Production result

The confirmed plan was committed on 2026-08-07 as legacy import batch
`efc54805-d5bd-4e3a-95de-685515a9e1ea`, using the primary active global Super
Admin as the migration actor. The commit report is
`backups/ke-post-cutoff-production-commit-2026-08-07.json`.

Independent read-only validation passed and is recorded in
`backups/ke-post-cutoff-production-post-validation-2026-08-07.json`. It confirms
111 K-Electric orders and zero cross-tenant orders/audits, 48 verified approval
tokens, 63 fulfilled/delivered orders, all 42 money-hold rows covered, no
cancelled imports, and the approved handling for Partial and order 1327.
