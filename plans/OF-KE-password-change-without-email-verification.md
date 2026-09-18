# OF-KE — Forced password change without the emailed code (temporary)

## Problem

Every K-Electric account was flagged `must_change_password` on 2026-09-17
(`plans/OF-KE-forced-password-rotation.md`). On next sign-in the person lands
on `/change-password`, which first sends a `VERIFY_EMAIL` code to the address
on the row and accepts a new password only after that code is entered back.
The client has asked for the emailed code to be removed **for now**: people
are being asked to verify an email they cannot readily reach, and are not
getting past the page.

What stays: the flag, the redirect, the API gate on a flagged session
(`lib/password-change-pending.ts`), the current-password check, the policy,
new ≠ old, the `session_version` bump and the sign-out of every device. What
goes, for now, is the proof that the mailbox on the row reaches the person.

## Decision: a policy constant in code, not an environment variable

`lib/password-change-policy.ts` (pure, no imports) holds one constant,
`PASSWORD_CHANGE_EMAIL_VERIFICATION: "required" | "disabled"`, and a
predicate `isEmailVerificationRequiredForPasswordChange()`. It is set to
`"disabled"`.

Why a constant and not `process.env`:

- The client wants the change on the next deploy. Production configuration
  lives outside this repository (the EC2 container's environment); an
  environment variable would need a second, coordinated change there, and a
  default of "disabled" in the validated env schema would leave every fresh
  deployment without the control by default.
- A security control that is switched by a value in a secret store can drift
  silently. A one-word change in a reviewed PR cannot. This is the same
  reasoning `lib/auth-brute-force-mode.ts` gives for reading no configuration.
- Re-enabling is a one-line PR: set the constant back to `"required"`. Every
  test for the required mode still runs (mocked to that mode), so the path
  cannot rot while it is off.

## Behaviour when verification is disabled

`lib/server/password-change.ts`:

- The advisory `hasFreshProof` check is skipped.
- Inside the transaction, the session row is still updated with
  `email_verified_at = null` under the predicate `id = <token session> AND
  subject_id = <account> AND revoked_at IS NULL` — the freshness term is the
  only thing dropped. The write therefore still proves the session is live and
  belongs to this account; a revoked or foreign session finds no row, nothing
  below it runs, and the outcome is the new `session_invalid`, which the route
  maps to 401 (matching the verify endpoint's answer for the same condition).
- The `AUTH_PASSWORD_CHANGED` audit row records `emailVerified: false`, so a
  reviewer can tell which rotations happened without a mailbox proof.
- Everything else is unchanged: lockout, current password, policy, new ≠ old,
  `must_change_password` cleared, `password_changed_at` stamped,
  `session_version + 1`, physical sessions dropped, validation cache
  invalidated.

`app/(auth)/change-password/page.tsx`:

- Starts on the password step, titled "Set New Password", with a notice that
  the account requires a new password. No send, no code, no address shown.
- A 403 `EMAIL_VERIFICATION_REQUIRED` from the server still falls back to the
  send step, so a page built one way and a server built the other cannot
  strand anyone.

The send/verify endpoints and the pending-API allowlist are untouched; they
are simply not called. `lib/server/email-verification.ts` is untouched.

## Security impact

- **Weakened, deliberately, at the client's request**: a person holding a
  handout password can set a new one without proving they hold the mailbox.
  The rotation still ends the handout password's life at first use, and the
  audit row says the proof was not taken.
- Authentication, authorization, tenant scope, input validation, rate limits,
  lockout, mass-assignment rejection: unchanged.
- No new secret, no new environment variable, no schema change.

## Tests

- `lib/password-change-policy.test.ts` — the predicate in both modes, and the
  current setting pinned so a change to it is a visible test diff.
- `lib/server/password-change.test.ts` (new, stubbed db) — in disabled mode:
  no advisory proof query, the transaction's session update carries the
  liveness predicate but not `PROOF_FRESH`, a missing row is
  `session_invalid`, the audit says `emailVerified: false`; in required mode:
  the existing shape, unchanged.
- `app/api/v1/users/me/change-password/route.test.ts` — `session_invalid` → 401.
- `app/(auth)/change-password/page.test.tsx` — the existing three-step suite
  runs with the policy mocked to `required`; a new block covers the direct
  form, that it never calls send/verify, and the fallback on 403.
- `lib/server/security-boundaries.test.ts` — the contract now also pins that
  the only relaxation is the policy predicate, imported from the pure module
  in both the server module and the page.
- `tests/integration/password-rotation.test.ts` — policy mocked to `required`
  so the full round trip keeps running against Postgres.
- `tests/integration/password-change-direct.test.ts` (new) — the default
  (disabled) mode against Postgres: change without any code, flag cleared,
  version bumped, sessions dropped, no `AUTH_EMAIL_*` rows, `emailVerified:
  false` in the audit, a revoked session refused with 401, the other account
  untouched.

## Rollback

Set `PASSWORD_CHANGE_EMAIL_VERIFICATION` back to `"required"` in
`lib/password-change-policy.ts` and update its pinning test. Nothing else
changes; no data to repair.
