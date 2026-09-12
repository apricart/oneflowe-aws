# OF-KE — Align production K-Electric to the legacy platform and the credential hand-out

**Scope:** organization 10 (`K-Electric`, code `0001`) in production, and the
scripts under `scripts/` + `lib/legacy-import/` that maintain it.
**Not in scope:** any other organization. Every write here is tenant-gated.
**Baseline:** `deliverables/ke-legacy-parity-2026-09-12.xlsx`
(`scripts/build-ke-legacy-parity-report.ts`, read-only).

## 1. What is wrong today

1. **The sync planner no longer recognises production accounts.** Usernames
   were regenerated to `<first name>-<code>-<ba|op>` on 2026-09-09
   (`lib/username-generation.ts`). `planUsers()` in
   `lib/legacy-import/ke-sync.ts` still derives the employee code from the
   username stem (`employeeCodeOf`), which now yields `<first name>-<code>`,
   so a dry run plans ~139 duplicate account pairs. `sync:ke --commit` is
   unsafe until this is fixed, and everything the sync delivers (12 products,
   63 September budgets, 4 branch moves, 5 branch renames, 2 group
   assignments) is stuck behind it.
2. **Accounts that do not match `user-logins-handout.xlsx`:**
   - 3 accounts still carry old-style usernames (`80004178-ba/op`,
     `1761044-ba`); the hand-out says `muhammad-80004178-*`,
     `muhammad-1761044-ba`. They were never aligned because the hand-out
     password does not verify against them (the person changed it, or the
     row was wrong). Username and name follow the hand-out; the password is
     **not** touched.
   - `head-1734549-ba` / `-op` (KE HOUSE) do not exist; `-op` is soft-deleted
     (0 orders) and the person holds only a `HEAD_OFFICE` account.
   - 3 accounts carry a damaged `external_id`: `9418` (legacy `09418`),
     `15377` (`15377084`), `7676` (`7676648`). The soft-deleted duplicates
     from 2026-09-05 still hold the correct codes.
   - 7 recycled login codes (18716, 16701, 11631, 11820, 12973, 16476, 18979):
     the *previous* holders sit on `checking-<code>-*` accounts with the real
     code in `external_id` and 30 orders; the *current* holders (per legacy
     and per the hand-out) carry `ke###` placeholders. Six previous holders
     are not in legacy at all; the seventh (11631) is, under 17124, and
     already holds `syed-17124-*`.
3. **Orders:** 22 live legacy orders (7–11 Sep) not imported; 8 orders whose
   status moved in legacy since the last resync; budget spend not recomputed
   since.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Username convention is `<first name>-<code>-<ba\|op>` (`buildUsername`). The sync generates it for new accounts and **never renames an account already in that shape**. | It is what every person has been told to type. |
| D2 | A mirrored account is identified by `external_id` first; the username stem is only a fallback for unstamped rows. | The code no longer lives in the username. |
| D3 | **No existing password is changed.** New accounts mirror the legacy password; a backfilled twin copies its sibling's hash. The one restored soft-deleted account (`head-1734549-op`) is set to the hand-out password only if its current hash does not already verify. | People have signed in and changed passwords. |
| D4 | `must_change_password` is left as it is. | The hand-out says "Yes" for all 294; 259 have already cleared it by signing in. Re-arming it would log people out for nothing. |
| D5 | Legacy is authoritative for who holds a login code. Previous holders of the 7 recycled codes are **retired** (`is_active=false`, `external_source='KE_LOGISTICS_RETIRED'`), keeping their orders and usernames; current holders are stamped with the real code. Committed only after explicit confirmation. | Six of seven are absent from legacy's own staff list; the seventh has a live account under the new code. Retiring, not deleting, preserves history and is reversible. |
| D6 | The hand-out `user-logins-handout.xlsx` (root) is the specification for usernames and names. It is applied through `align:handout`, which the plan file for that script says must not be re-run blindly — so it is run **after** D5 has moved the previous holders off the codes, and only rows that still differ are written. | The mistake it made before was matching a code to its previous holder; D5 removes that possibility. |

## 3. Code changes

- `lib/legacy-import/ke-sync.ts` — `employeeCodeOf` understands the named
  shape; `planUsers` matches holders by `external_id` then username code;
  new-person and backfill usernames come from `buildUsername`; backfill
  carries `sourceUserId`; `planUsernameMigration` only touches
  BRANCH_ADMIN/ORDER_PORTAL accounts and produces the named shape when a
  first name is known; `CurrentUser.firstName` added; `takenUsernames`
  option so soft-deleted and other-tenant usernames are respected.
  Tests updated in `ke-sync.test.ts`.
- `scripts/sync-ke.ts` — passes first names and the global username set;
  backfill copies credentials from `sourceUserId`.
- `scripts/align-accounts-to-handout.ts` — `--trust-login-codes=<a,b>`
  plans a login-code match for the named codes even when the password does
  not verify (username and name only; reported as such).
- `scripts/repair-ke-account-identities.ts` — **new**, dry-run by default,
  digest-gated, org 10 only, `system_logs` per account, rollback from its
  committed report. Steps: (a) restore `head-1734549-op`; (b) repair the 3
  truncated `external_id`s after retiring their soft-deleted duplicates;
  (c) retire previous holders of recycled codes and stamp current holders
  (D5, behind `--include-recycled-codes`).

## 4. Execution order (production)

```
0  npm test / typecheck / lint                     code is green
1  repair:ke-identities   dry → commit             (b) and (a); (c) after confirmation
2  align:handout --trust-login-codes=80004178,1761044   dry → commit   3 rows + head-1734549-op
3  sync:ke                dry → commit, twice      products, budgets, moves, renames, groups, head-1734549-ba
4  import:ke-orders       dry → commit             21 orders (2558 is refused: legacy total 0)
5  resync:ke-order-status dry → commit             8 orders
6  backfill:ke-budget-spend dry → commit           recompute spend/held
7  verify:credentials, build-ke-legacy-parity-report   evidence
```

Each dry run's digest is re-read at commit time; a moved plan is refused.

## 5. Verification

- `verify:credentials --file=user-logins-handout.xlsx`: every row `OK` or
  drifting only on `must-change-password` (D4), plus the 9 password
  mismatches, which are people who changed their password and are reported,
  not fixed.
- `build-ke-legacy-parity-report.ts`: 0 live orders missing (except 2558),
  0 branch name/group issues, 0 products missing, 0 budgets missing for the
  current month, 148/148 people matched with no `external_id` drift.
- `sync:ke` dry run reports nothing to do.

## 6. Risk and rollback

- Every script is dry-run by default and digest-gated. `repair` and
  `align` write a committed report that feeds `--rollback`. `sync:ke`
  supports `--rollback-test`; its creates are additive.
- Tenant gate: every UPDATE carries `organization_id = 10`; the repair
  script asserts the organization's name before writing. Organization 2
  (K-E-Demo) shares emails and must not be touched — nothing here matches
  by email across tenants.
- Blast radius of D5: 14 accounts lose sign-in. They are previous holders
  of reissued codes; their orders stay attributed to them.

## 7. Execution record (2026-09-12, production, operator itsupport@swenta.com)

| Step | Result | Evidence |
|---|---|---|
| 1 identity repair | 41 rows committed (6 duplicates re-tagged, 6 stamps repaired, 14 previous holders retired, 14 current holders stamped, `head-1734549-op` restored; no password written — the stored hash already verified) | `deliverables/ke-identity-repair-committed-20260911T213432.json`, `system_logs` action `KE_ACCOUNT_IDENTITY_REPAIR` |
| 2 hand-out alignment | 3 rows (`muhammad-80004178-ba/op`, `muhammad-1761044-ba`), names from the hand-out, passwords untouched | `deliverables/handout-alignment-committed-1789163179609.json` |
| 3 sync:ke | batch `540e9886-…`: 5 branch renames, 6 branch moves, 2 group assignments, 12 products, 63 budgets (2026-09), `head-1734549-ba` backfilled. Second pass: "Nothing to sync". | `updatedReports/ke-sync-2026-09-11.json` |
| 3b correction | the 5 products that exist only in legacy's price history were assigned active by the sync; deactivated (`KE_RETIRED_PRODUCTS_DEACTIVATED`) and `applyProducts` fixed to assign retired products inactive | `system_logs` |
| 4 import:ke-orders | batch `029b93da-…`: 21 orders, 230 lines (legacy 2558 refused: checkout total 0) | rollback command in the batch output |
| 5 status resync | 7 orders; 9 held as before (refunds, backwards moves, non-live legacy rows) | `deliverables/ke-status-resync-2026-09-11.json`, audit 1321 |
| 6 budget spend backfill | 134 updates, 7 inserts, spent = 5,674,235,946 cents; the script then crashed on `cache-utils` **after** committing — switched to `lib/cache-cli` and cleared the prefixes manually | audit `KE_BUDGET_SPEND_BACKFILL` 21:58 UTC |
| 7 verification | hand-out: 0 not found, 0 ambiguous, 9 password mismatches (people who changed their password), 259 `must-change-password` (D4), 18 branch drifts (hand-out predates legacy's current branch names). Parity: 937/938 live orders, 136/136 branches, 4/4 groups, 148/148 people, 158/158 products, 64 budgets matched. | `deliverables/credential-handout-verification.xlsx`, `deliverables/ke-legacy-parity-2026-09-12-after.xlsx` |

Left open, deliberately: 5 September budgets whose allocation differs from legacy (`IBC UTHAL R3` 0 vs 30,000; `Technical head R3` 0 vs 10,000; three raised by the backfill to exactly their spend) — the sync never rewrites an allocation; 3 products where the organization price differs from legacy's modal price; branch `Technical` (id 245, now empty) not deactivated; orders 1472 / 2519 on the twin-named branches (`Johar |/||`, `Society Cluster` ×2).
