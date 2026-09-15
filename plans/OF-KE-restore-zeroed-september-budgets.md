# OF-KE — Restore K-Electric's September 2026 budgets after the zero run

## Problem

On 2026-09-14 04:35 local, `npm run sync:ke -- --budgets=zero --reset-stock`
was committed to production as batch `69cb822a-c40a-495b-99ac-33a87ac46c0d`
(report: `updatedReports/ke-sync-zero-commit.json`). On the budget side it:

- **lowered 64** `budgets` rows for `2026-09` to their `spent + held − credited`
  floor (PKR 4,494,338 of remaining allocation released);
- **cleared 53** `branches.baseline_budget_cents` to `0`;
- **created 55** `budgets` rows at `0` for branches that had no row for the
  month — none of which carried a baseline.

The instruction has changed: the September budgets are to be what they were
before the zero run, and the monthly re-allocation is to work again.

The re-allocation is not a code condition that was switched off — nothing under
`app/` or `lib/` changed. It is `branches.baseline_budget_cents`, which the
application reads whenever it creates a month's row (`loadSingleBranchBudget`
and `syncCurrentMoneyBudgets` in `app/api/v1/budgets/route.ts`,
`getOrCreateCurrentBudget` in `lib/server/group-order-creation.ts`). The zero
run set it to `0` on 53 branches precisely so that a zeroed month would stay
zero. Putting the 53 values back restores the behaviour.

## Change

A dedicated script, not another `sync:ke` mode: the sync mirrors the legacy
platform, and this is an undo of one committed batch from that batch's own
report. Restoring to the report's before-values — not to legacy's current
figures — is what "same as before" means; the two differ on roughly ten
locations (the legacy-mode dry run of the same day planned 10 raises), and
aligning to legacy is a separate, later decision (`sync:ke --budgets=legacy`).

### 1. `lib/legacy-import/ke-budget-restore.ts` (new, pure)

- `parseZeroRunReport(raw)` — Zod-validates the report file at the boundary:
  `mode = COMMIT`, `options.budgetMode = zero`, a `YYYY-MM` `zeroPeriod`, the
  organization identity, and the `budgets.lowers` / `budgets.baselineResets` /
  `budgets.creates` arrays with their before-values. A dry-run report or a
  legacy-mode report is refused.
- `planBudgetRestore(report, currentBudgets, branches)` returns:
  - `allocationRestores` — one per `lowers` entry whose row is **still at the
    value the zero run wrote**: `amount_allocated_cents` goes back to the
    report's `currentCents`. Raising an allocation can never break
    `budgets_values_valid_ck`, so no invariant check is needed.
  - `baselineRestores` — one per `baselineResets` entry whose branch **still
    has baseline `0`**: back to the report's `currentCents`. Each carries
    `refundsOnNextLoad`, true when the month row is at `0` with nothing spent
    or credited, because `syncCurrentMoneyBudgets` will then reset that row to
    the baseline on the next Head Office page load — the same thing it would
    have done before the zero run, but worth saying out loud.
  - `unchanged` — rows already back at their before-value (a second run is a
    no-op).
  - `skipped` — `ROW_MISSING`, `ALLOCATION_MOVED` (neither the zeroed nor the
    restored value: someone changed it since; reported, never overwritten),
    `BRANCH_MISSING`, `BASELINE_MOVED`.
  - `createdAtZero` — the 55 rows created at `0` are **left alone**: none of
    those branches had a baseline, so a `0` row is exactly what the
    application creates on demand, and deleting it would only be recreated.
- `restorePlanLines(plan)` — the digest input; includes the source report's
  own `planDigest`, so a plan built from a different report never matches.
- `summarizeRestore(plan)`.

### 2. `scripts/restore-ke-zeroed-budgets.ts` (new)

Same shape as `scripts/sync-ke.ts` and
`scripts/restore-ke-branch-budget-carryforward.ts`:

- `--report=<path>` (default `updatedReports/ke-sync-zero-commit.json`),
  `--output=<path>`, `--commit`, `--rollback-test`,
  `--actor-user-id=<active SUPER_ADMIN uuid>`,
  `--confirm-organization=<id:code:name>`, `--confirm-plan=<digest>`.
- Dry run by default. Reads the organization (must match the report's
  `id:code:name`), every `budgets` row of the organization for the period, and
  every branch of the organization; plans; prints; writes a JSON report with
  the before-values of what it will change (its own rollback input).
- Commit: one transaction under `pg_advisory_xact_lock(hashtext('oneflowe:ke-sync'))`
  so it cannot interleave with a sync; re-reads and re-plans under the lock and
  refuses if the digest moved; every `UPDATE` is pinned to the value the plan
  saw (`and amount_allocated_cents = $zeroed`, `and baseline_budget_cents = 0`)
  and must affect exactly one row; records a `legacy_import_batches` row
  (`importer: restore-ke-zeroed-budgets`, the report's path, sha256 and
  digest); after commit, re-plans and asserts nothing remains, asserts the
  other-tenant and other-period fingerprints are unchanged, and clears the
  `budgets`/`analytics`/`branches` cache prefixes through `lib/cache-cli.ts`.
- `--rollback-test` applies and rolls back, like the sync.
- Writes only `budgets.amount_allocated_cents` (for the report's period) and
  `branches.baseline_budget_cents`, both under `organization_id = <report org>`.
  No price, stock, inventory, order or user column is touched.

### 3. `package.json`

`"restore:ke-zeroed-budgets": "tsx scripts/restore-ke-zeroed-budgets.ts"`.

### 4. `CLAUDE.md`

One bullet under the `--budgets=zero` note: the zero run is reversed from its
report by `npm run restore:ke-zeroed-budgets`, which restores both the
allocations and the baselines.

## Tests

- `lib/legacy-import/ke-budget-restore.test.ts`: report validation (dry-run
  report refused, legacy-mode report refused, malformed period refused);
  allocation restored when the row is at the zeroed value; unchanged when
  already restored; `ALLOCATION_MOVED` when neither; `ROW_MISSING`; baseline
  restored when `0`; unchanged when already back; `BASELINE_MOVED`;
  `BRANCH_MISSING`; `refundsOnNextLoad` only for a zero row with no activity;
  created-at-zero rows never planned; idempotent against its own result; digest
  changes with the source report.
- `npm test`, `npm run typecheck`, `npm run lint`.
- The script's SQL is rehearsed end to end on the disposable local database
  (`oneflowe_test`, tenant `KETEST`, which already holds the zeroed state from
  the earlier rehearsal): fund a handful of branches and baselines, run
  `sync:ke --budgets=zero` against it to produce a real report, restore from
  that report, verify the funded state came back exactly, run the restore
  again (no-op), run the zero mode again (re-zeroes — proves the pair is
  reversible).

## Security and data impact

- No endpoint changes. The script requires an active `SUPER_ADMIN` actor, the
  organization confirmation and the plan digest, exactly as the sync does.
- Tenancy is pinned by `organization_id` on every statement, and the
  organization identity is checked against the report before anything is read.
  Organization 2 (`K-E-Demo`) cannot be reached.
- Every write is a raise (allocation) or a set-from-zero (baseline), each
  pinned to the current value, so a row a Head Office user changed since the
  zero run is reported and left alone.
- The report file is parsed with Zod; its branch ids and amounts are only ever
  used as predicates and values against the report's own organization.

## Rollback

Re-running `npm run sync:ke -- --budgets=zero` re-zeroes the month and clears
the baselines again; the restore script's own report also holds the values it
replaced.
