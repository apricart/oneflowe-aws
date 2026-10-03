# OF-AUTH — Self-service password reset by emailed code

## Requirement

> 12. Password Reset — users should be able to reset their own passwords
> through the portal without requiring administrative intervention, subject to
> the applicable authentication/verification process.

Every user can reset their own password. A one-time code is sent to the email
on their account, and nothing changes until that code comes back. The Order
Portal (`/shop`) had no profile menu, so it gets one, with the reset entry in
it. The admin shell's topbar menu gets the same entry.

## Flow

1. `/forgot-password` (public page) asks for a username or email.
2. `POST /api/v1/auth/password-reset/request` answers **202 with a challenge
   id for every input**. It mails a 6-digit code only when the input resolves
   to exactly one active, routable account.
3. `POST /api/v1/auth/password-reset/verify` takes the challenge id and code
   and returns a 256-bit reset token that is valid for 10 minutes.
4. `POST /api/v1/auth/password-reset/complete` takes the challenge id, the
   token and the new password (twice). It sets the password and signs the
   account out everywhere.

The login page links to step 1, and so do both profile menus. A signed-in
person who completes a reset is signed out on this browser too.

## Who can be reset, and by what identifier

The service matches the login rules in `lib/auth-options.ts`
(`loadStaffLoginRecord`, `loadEmployeeLoginRecord`):

- **Username**: the staff account first, then the Order Portal employee
  credential. This is the same precedence the login page uses.
- **Email**: accepted only when it names exactly one active account across
  both credential stores. A mirrored account (`external_source` set) is never
  matched by email, because K-Electric people hold one account per role behind
  one shared address. They reset by username, just as they sign in by
  username.
- The account, its organization and its branch must all be active. The
  address must be routable (`isRoutableEmailAddress`), so no code goes to the
  `.invalid` placeholders the KE sync writes.

## Storage: `password_reset_challenges`

This is a new table (migration `20260929184428_add_password_reset_challenges`).
It is additive, so nothing existing is touched. `mfa_codes` is not reused: it
stores codes in recoverable form and keys on a UUID user id, which leaves out
employee principals (`emp_<id>`).

- `code_digest` and `reset_token_digest` are HMAC-SHA256 values keyed on
  `NEXTAUTH_SECRET` and bound to the challenge id. Neither the code nor the
  token is stored.
- `attempts` is capped at 5 by a check constraint. The fifth wrong guess
  consumes the challenge.
- A partial unique index on `(subject_type, subject_id) WHERE consumed_at IS
  NULL` allows one live challenge per account. A new request consumes the old
  one inside the same transaction, and concurrent requests cannot both
  succeed.
- There is no foreign key on `subject_id`, the same as `auth_sessions`,
  because it holds either a user UUID or `emp_<id>`.
- RLS is enabled, and policies install only where the staged
  `oneflowe_rls.auth_bootstrap()` helper exists. This is the same pattern as
  `auth_sessions`. `anon` and `authenticated` are revoked.

## Security properties

| Threat | Control |
|---|---|
| Account enumeration by response | The request step returns the same 202 body for every outcome. For a non-account it returns a random decoy id. The verify step returns one message for every rejection and **no remaining-attempt count**: a decoy has nothing to count, so showing a count for real challenges would reveal which usernames exist. |
| Account enumeration by timing | The email is sent after the response, through `after()` from `next/server`. The response is also held to `PASSWORD_RESET_REQUEST_MIN_RESPONSE_MS` (700 ms), which covers the few extra queries a real account costs. The verify step runs the attempt-counting `UPDATE` on decoys as well, where it is a no-op. |
| Code guessing | 6 digits, at most 5 guesses per challenge, 10-minute expiry. `otpSend` limits requests per IP and per keyed identifier digest, and there are at most 10 challenges per account per day. `otpVerify` limits guesses per IP and per challenge. |
| Token theft or replay | 32 random bytes, stored only as a digest, valid for 10 minutes. `complete` consumes it in the same transaction that writes the password, and a guarded `UPDATE … WHERE consumed_at IS NULL` lets only one of two concurrent completions through. |
| Session survival | Completion bumps `session_version`, revokes every `auth_sessions` row for the subject, expires legacy `sessions` rows and drops the session-validation cache entry. |
| Mass assignment | Zod `.strict()` bodies. The account is taken from the challenge row, never from the request. |
| Lockout interplay | A completed reset clears `failed_login_attempts` and `lockout_until`, since proving control of the mailbox is the recovery path. It also clears `must_change_password`, because the person has just chosen a new password under the same policy. |
| Audit | `AUTH_PASSWORD_RESET_REQUESTED`, `_VERIFIED`, `_COMPLETED` and `_FAILURE` go to `system_logs` through `recordAuthAuditEvent`. No code, token or password is logged. |

`/forgot-password` is not in `proxy.ts`'s `protectedPrefixes`, so it is
reachable when signed out, and an `ORDER_PORTAL` session is not bounced back
to `/shop`.

## Known limits

- An attacker who knows a username can use up that account's 10 daily
  challenges, which blocks self-service reset for that person until the next
  day. Administrators can still reset the password. This is the usual
  trade-off, and the per-identifier `otpSend` limit slows it down.
- A session that still owes a forced password change is refused by the
  `/api/v1/*` gate in `proxy.ts`. It should use `/change-password`, which it
  is already redirected to.

## Tests

- Unit: `lib/server/password-reset.test.ts` (digests, contract), and the three
  `route.test.ts` files (generic responses, deferred delivery, response floor,
  no attempt count, strict bodies, rate limits).
- UI: `app/(auth)/forgot-password/page.test.tsx`, plus the storefront header
  tests.
- Integration: `tests/integration/password-reset.test.ts`, against real
  Postgres. It covers decoys for unknown, inactive and suspended-tenant
  accounts, username-only for mirrored accounts, ambiguous email, one live
  challenge under concurrency, a withdrawn code on failed delivery, the daily
  cap, identical real and decoy rejection, the attempt cap, expiry, single-use
  verify, completion (password, lockout, flag, version, sessions, bystander
  untouched, audit), token replay, the concurrent-completion race, employee
  principals, and deactivation between verify and complete.

## Rollback

The code can be reverted on its own, and the table can stay (it is unused
without the code). To remove it: `DROP TABLE password_reset_challenges;` in a
later release, after the code that reads it is gone.
