# OF-KE — Align production K-Electric accounts to the credential hand-out

## Problem

`user-logins-handout.xlsx` was produced from the **test** database after two
corrections had been committed there (`fix:user-names`, then
`fix:usernames`). Production (organization `0001`, id 10) never received either,
so every username in the hand-out (`<first name>-<code>-<ba|op>`) is unknown to
production, whose accounts still carry `<code>-<ba|op>`. Mirrored accounts sign
in by username only, so the hand-out as distributed does not work.

Replaying the two scripts on production is blocked:

- `fix:user-names` confirms each (email, role, branch) match against `phone`.
  The review sheet came from the test portal, where `sync:ke` had populated
  phones; production has a phone on 34 of 323 accounts, so 210 matches fail.
- The same script refuses because `hafiz.mirfan@ke.com.pk` holds two employee
  codes (18553, 16944) and production has all four accounts on branch `1. GSO`
  (legacy puts 16944 on `GSO`), so the key is ambiguous.
- `fix:usernames` would rename all 323 accounts, including 34 that are not in
  the hand-out (19 active) — those people would be locked out with no new
  credential to hand them.

## Approach

Treat the hand-out as the specification. Each row carries the corrected name,
the target username and a password that must `bcrypt`-verify against the
production hash — a stronger identity confirmation than the phone column, and
one that ties the row to the account the password was actually set for.

`lib/handout-alignment.ts` (pure, unit-tested):

1. Match a row to an account by `Login Code` ↔ `users.external_id` plus the
   portal suffix of the username; fall back to (email, role) when the code does
   not match, which covers the accounts whose production `external_id` is
   truncated or a `ke###` placeholder. Refuse anything ambiguous.
2. Only a row whose password verifies is planned. Others are reported.
3. Plan `username`, `full_name`, `first_name`, `last_name` per account; refuse a
   target username held by any other row in the table (the unique index has no
   tenant or deleted predicate).

`scripts/align-accounts-to-handout.ts`: read-only preflight by default, writes a
JSON report and an Excel report (planned / blocked / not in hand-out /
remaining). Commit is checksum-gated, one transaction, advisory-locked,
re-verifies every target under `FOR UPDATE`, stages renames through a parking
value, writes a `system_logs` row per account, and produces a committed report
that feeds `--rollback`.

## Out of scope (reported, not changed)

- Branch moves (8 rows differ, including the 16944 pair → `GSO`).
- `external_id` corrections for the 18 accounts with truncated/placeholder codes.
- `must_change_password`, which production has already cleared for most rows.
- The 34 production accounts absent from the hand-out.
- The 3 rows whose password does not verify.

## Verification

`scripts/verify-credential-handout.ts` after commit: every planned row must be
`OK` or drift only on branch / must-change-password.

## Correction after the first commit (2026-09-11)

The first commit (`handout-alignment-committed-1789122957374.json`, 289 rows)
mis-addressed 14 accounts. On 2026-09-04 a reconciliation
(`deliverables/ke-user-reconciliation-2026-09-04-v2.xlsx`, "Action - Person
Changed") found seven legacy login codes whose holder had changed — 18716,
16701, 11631, 11820, 12973, 16476, 18979. Production kept each code on the
**previous** holder's account (with its order history) and created `ke###`
placeholder accounts for the new holders. The hand-out, built from the test
database where the sync had given those codes to the new holders, therefore
named the new holder on each code; matching by login code landed on the old
holder's account, and the password verified because the legacy password
belongs to the login, not the person.

Correction, in this order:

1. `--rollback=deliverables/handout-alignment-revert-person-changed.json` —
   the committed report filtered to those 14 rows; restores the old holders'
   usernames and names, audited as `USER_HANDOUT_ALIGNMENT_ROLLBACK`.
2. `scripts/build-handout-supplement.ts` builds rows for the 16 active
   accounts the hand-out never covered (the seven new holders plus Yasir
   Mohiuddin, 9418), joined to the legacy list by email, password-verified,
   with an `Account code` column naming the account's own `external_id`.
   `lib/handout-alignment.ts` prefers `Account code` over `Login Code` when
   matching, so the supplement addresses the `ke###` accounts.
3. `align:handout --file=deliverables/user-logins-handout-supplement.xlsx`,
   preflight then commit.

`deliverables/user-logins-handout-complete.xlsx` is the hand-out to
distribute: the original rows with the 14 superseded ones replaced by the
supplement. **The original `user-logins-handout.xlsx` must not be run through
`align:handout` again** — it would re-apply the mistake.

Lesson: a legacy login code identifies a *position*, not a person. Any join
on `external_id` for K-Electric must consult the person-changed list.
