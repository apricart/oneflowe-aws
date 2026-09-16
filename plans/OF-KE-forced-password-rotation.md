# OF-KE — Forced password rotation with email verification for K-Electric

## Problem

Every K-Electric account (organization 10, code `0001`) still carries the
password it was handed out with (`user-logins-handout.xlsx`), and a legacy
login code is a *position*, not a person — the same password verifies on the
`-ba` and `-op` account of a code, and on a retired holder's account until it
was deactivated. Those passwords have travelled on paper and in spreadsheets.
They are to be rotated: every K-Electric user must set a password of their
own on next sign-in, and must prove they hold the mailbox on the account
before the new password is accepted.

What exists today:

- `users.must_change_password` already exists and is set on portal-created
  accounts. `proxy.ts` sends a flagged session to `/change-password` for
  **page** navigation only; API requests go through `handleApiRequest`, which
  never reads the flag. Exactly four handlers check it themselves
  (`orders` GET/POST, `budgets` GET/PATCH, `branch/inventory`). The other
  ~120 route handlers accept a flagged session. The gate is UX, not a control.
- `POST /api/v1/users/me/change-password` accepts a new password from any
  signed-in session with no second factor and no check that the new password
  differs from the old one.
- `lib/mfa.ts` already implements email OTP with a `VERIFY_EMAIL` type,
  cooldown (1 min), attempt cap (5), daily cap (20), one active code per
  user+type, Redis + Postgres storage. Only `LOGIN` is wired to an endpoint.
- The JWT carries `mustChangePassword` from sign-in time. Setting the column
  alone does **not** affect a session that is already open — it keeps its
  8-hour token with `mustChangePassword=false`. Only a `session_version` bump
  forces it out (`validateSessionTokenAgainstDatabase`).
- Some K-Electric accounts have an address on `ke-legacy.invalid` — the sync
  derives one when the legacy system holds no email (`fallbackEmail` in
  `lib/legacy-import/ke-sync.ts`). Those can never receive a code. Twelve
  legacy emails are shared by more than one person, and every person's `-ba`
  and `-op` accounts share one address by design.

## Change

### Flow (differs from the first draft: the code comes *before* the password)

1. Script flags the chosen accounts: `must_change_password = true`,
   `session_version + 1`. Anyone signed in is dropped at their next request.
2. The person signs in with **username** and the old password (mirrored
   accounts cannot sign in by email; that guard is untouched). Login MFA, if
   enrolled, runs as today.
3. The session is issued with `mustChangePassword = true`. Pages redirect to
   `/change-password` (today's behaviour); **every `/api/v1/*` request is
   refused with 403 except the allowlist below** (new).
4. `/change-password`, step 1 — the page shows the masked address on file and
   sends a `VERIFY_EMAIL` code to it.
5. Step 2 — the person enters the code. On success the server records a
   **single-use proof bound to this session**, valid 10 minutes.
6. Step 3 — current password, new password, confirmation. The change endpoint
   consumes the proof in the same transaction that writes the hash. Nothing
   is written until the mailbox has been proven.
7. `session_version + 1`, every session of the account is revoked, the person
   signs in again with the new password. `must_change_password` is now false.

Why code-first rather than password-then-code: with password-first, the hash
is already replaced before the second factor runs — someone holding the
handout password could set their own password and be stopped only
afterwards, and a person who fails the code is left half-migrated. Code-first
needs no pending state and no way to be interrupted with the account changed.

### 1. Schema — additive, nullable, no backfill

- `users.email_verified_at timestamptz` — when the address on the row was
  last proven to reach the person. Reporting, and a future precondition for
  enabling login MFA.
- `users.password_changed_at timestamptz` — set by every self-service change.
  The unambiguous "completed" signal for the rotation report (a
  `must_change_password` cleared by an administrator is not a rotation).
- `auth_sessions.email_verified_at timestamptz` — the proof. Set by the verify
  endpoint on the **current** session row; consumed (set back to null) by the
  change endpoint in its transaction. Single-use, session-bound, durable, no
  Redis dependency. A session that ends without consuming it takes the proof
  with it.

Generated with `npm run db:generate`; three `ADD COLUMN ... NULL` statements,
no lock of consequence.

### 2. API gate — `proxy.ts`, `handleApiRequest`

Read the token (`getToken`, as the page branch already does). When
`mustChangePassword === true` and the path is not in
`PASSWORD_CHANGE_PENDING_API_ALLOWLIST`, respond
`403 { error: "Password change required", code: "PASSWORD_CHANGE_REQUIRED" }`.

Allowlist (exact paths, exported so a contract test can pin it):

- `/api/v1/users/me/change-password`
- `/api/v1/users/me/email-verification/send`
- `/api/v1/users/me/email-verification/verify`

Sign-out and session refresh use `/api/auth/*`, which the `/api/v1` matcher
never sees, so they keep working. The four in-handler checks stay as they
are: the proxy gate is a check on a signed claim, not a lookup the handler
must repeat, but the rules are right that a handler must not *depend* on the
edge — the change endpoint itself demands the proof, so the one write that
matters is protected twice.

### 3. Email verification endpoints (new, session-scoped, no username in the body)

Both: `getCurrentUser()` → 401; `emp_*` principal → 400 (employee store
accounts are out of scope); rate limited per user (`otpSend` / `otpVerify`
buckets already exist in `lib/rate-limiter.ts`).

- `POST /api/v1/users/me/email-verification/send` — body empty. Loads
  `users.email`; an unroutable address (`.invalid` TLD or failing
  `isValidEmailAddress`) → `409 { code: "EMAIL_UNROUTABLE" }` with a message
  telling the person to contact their administrator, and no code is
  generated. Otherwise `generateAndSendOTP(userId, email, "VERIFY_EMAIL")`
  (its cooldown and daily cap apply) → `{ sent: true, emailHint }` where
  `emailHint` is the address masked (`r***@ke.com.pk`) — the page runs on
  shared branch PCs. Audit `AUTH_EMAIL_VERIFICATION_SENT`.
- `POST /api/v1/users/me/email-verification/verify` — body `{ code }`,
  Zod `^\d{6}$`, strict. `verifyOTP(userId, code, "VERIFY_EMAIL")`. Success:
  in one transaction set `auth_sessions.email_verified_at = now()` where
  `id = <session id from the token> AND subject_id = <user>` and
  `users.email_verified_at = now()`; audit `AUTH_EMAIL_VERIFIED`; respond
  `{ verified: true, validForSeconds: 600 }`. Failure: 400 with the MFA
  module's message and remaining attempts; audit
  `AUTH_EMAIL_VERIFICATION_FAILURE`.
- The session id comes from the JWT (`token.sessionId`) read server-side in
  the handler — a small `lib/server/current-session.ts` helper around
  `getToken` — not from `session.user`, so it is never sent to the browser.
- `OTP_CONFIG.EXPIRY_MINUTES` becomes per type: `LOGIN` stays 2,
  `VERIFY_EMAIL` 10. Corporate mail is not instant and the person is reading
  it on another device.

### 4. `POST /api/v1/users/me/change-password` — hardened

Logic moves to `lib/server/password-change.ts`; the route authenticates,
validates, delegates. Body `{ currentPassword, password }`, Zod, strict.

In one transaction:

1. Consume the proof:
   `UPDATE auth_sessions SET email_verified_at = NULL WHERE id = $session AND subject_id = $user AND email_verified_at >= now() - interval '10 minutes' RETURNING id`.
   No row → `403 { code: "EMAIL_VERIFICATION_REQUIRED" }`, nothing written.
2. Verify `currentPassword` against the stored hash → 400 on mismatch (counts
   against the account's lockout budget like a failed login).
3. Reject a new password equal to the current one → 400 "must differ".
4. `hashPassword` (complexity as today), `must_change_password = false`,
   `password_changed_at = now()`, `session_version + 1`, lockout cleared,
   `sessions` rows deleted, validation cache invalidated (as today).
5. Audit `AUTH_PASSWORD_CHANGED` with `{ forced, emailVerified: true }`.

The proof requirement applies to every self-service change, not only the
forced one — today this endpoint has exactly one caller, the forced page, so
this is not a behaviour change for anyone else, and a second path that skips
the second factor would be the first thing to be abused.

### 5. `/change-password` page — three steps

Step 1 explains why and shows the masked address with a **Send code** button.
Step 2 is `components/mfa/otp-input.tsx` with a resend button that respects
the cooldown returned by the server. Step 3 is current / new / confirm, as
today, submitted only after step 2 succeeded (the server enforces it
regardless). `EMAIL_UNROUTABLE` renders a terminal message with no button: the
person needs an administrator to put a real address on the account
(`PATCH /api/v1/users/[id]` already allows that for Head Office).

### 6. `scripts/force-password-rotation.ts` (new) + `lib/forced-password-rotation.ts` (pure planner)

    npm run rotate:passwords -- --organization-code=0001                       # dry run, everyone
    npm run rotate:passwords -- --organization-code=0001 --usernames=a,b       # pilot
    npm run rotate:passwords -- --organization-code=0001 --roles=BRANCH_ADMIN,ORDER_PORTAL
    npm run rotate:passwords -- --organization-code=0001 --status              # read-only progress
    npm run rotate:passwords -- ... --commit --actor-user-id=<super admin> \
        --confirm-organization=<id:code:name> --confirm-plan=<digest>
    npm run rotate:passwords -- --reverse=<commit report> [--commit ...]

Selection (planner, tested):

- Organization resolved by `--organization-code`, refused if the name is not
  the expected tenant (`assertOrganization`). Organization 2 (`K-E-Demo`) is
  unreachable by construction; the SQL is pinned to the confirmed id.
- `deleted_at IS NULL AND is_active`; `external_source IS NULL OR
  external_source = 'KE_LOGISTICS'` — `*_RETIRED` holders and
  `@historical.invalid` synthetic authors are never flagged.
- `--roles` narrows; default is every role in the tenant, reported per role.
  `SUPER_ADMIN` has no organization and is never selected.
- `--usernames` pins the run to named accounts (the pilot).
- Unroutable address → `EMAIL_UNROUTABLE`, **skipped** and listed, unless
  `--include-unroutable` is passed deliberately (which locks those people out
  until an administrator fixes the address — the flag exists so the choice is
  explicit, never the default).
- `must_change_password` already true → `ALREADY_FLAGGED`, unchanged; a
  second run reports nothing to do.
- An address held by more than one `external_id` → `EMAIL_SHARED` warning,
  still flagged; the list goes to K-Electric.

Commit: the plan is rebuilt and its digest re-checked inside the transaction;
each row is pinned to its before-values
(`WHERE id = $1 AND must_change_password = false AND session_version = $2`)
and the update count must equal the plan; one `system_logs` row per account
(`AUTH_PASSWORD_ROTATION_FORCED`, actor = `--actor-user-id`); one
`legacy_import_batches` row; the session-validation cache is invalidated per
account through `lib/cache-cli`; the commit report (`--output`) records every
account's before-values.

Reverse: clears `must_change_password` only where it is still true **and**
`password_changed_at` is still null (the person has not rotated) **and**
`session_version` is exactly `before + 1` (nothing else moved). Never
decrements `session_version` — that would revalidate tokens already revoked.

`--status`: per role, `pending` (flag still set), `completed`
(`password_changed_at >= batch created_at`), `unroutable`, with usernames for
the first two on request. Read-only.

### 7. Tests

- `lib/forced-password-rotation.test.ts` — selection and every exclusion,
  idempotency, `--usernames`, `--roles`, unroutable default vs
  `--include-unroutable`, shared-email warning, reversal pinning (rotated
  account left alone; moved `session_version` left alone), digest stability.
- `proxy.test.ts` — flagged token: 403 on `/api/v1/orders`, passes on each
  allowlisted path; unflagged token unaffected; the allowlist is exactly the
  three paths (contract).
- `lib/server/password-change.test.ts` (unit, mocked db) — proof missing,
  proof expired, wrong current password, new = old, happy path fields.
- `tests/integration/password-rotation.test.ts` — proof is single-use; proof
  on session A cannot be consumed by session B of the same user; proof
  written by the verify endpoint is consumed by the change endpoint in one
  transaction and a failed hash write leaves it in place; `session_version`
  bump; cross-tenant: a user in organization B is untouched by a run scoped
  to A; `K-E-Demo` fingerprint unchanged.
- Route tests for the two new endpoints: 401, `emp_` → 400, unroutable →
  409, rate limited → 429, happy path masks the address.

## Security and tenancy

- **Authentication**: the mirrored-account email-login guard is untouched.
  Sign-in still needs the old password; the rotation adds a mailbox proof on
  top, it never replaces the password.
- **Authorization**: a flagged session can reach three endpoints and one
  page. The proxy gate is on a signed claim; the change endpoint demands the
  proof itself, so the write is protected without the edge.
- **Replay / idempotency**: the proof is consumed in the transaction that
  writes the hash; a retried change after success finds no proof and no
  session (revoked). Codes are single-use and one-per-type already.
- **Enumeration**: the new endpoints take no identifier — the session is the
  identifier. Failure messages come from `lib/mfa.ts`, identical for wrong
  and expired codes.
- **Tenant isolation**: the script writes only rows of the confirmed
  organization id; organization 2 shares emails and is excluded by id, not
  by name.
- **Secrets / PII**: the address is masked on the page and never logged in
  full by the new code (`maskSensitiveData`); no code, password or token is
  written to `system_logs`.
- **Known limit**: a shared mailbox (twelve legacy addresses, and every
  `-ba`/`-op` pair) proves possession of the mailbox, not of the person. That
  is the only channel K-Electric has given us; the report names the shared
  ones so they can be split.

## Rollback

- Code: revert the deploy. The three columns are nullable and unused by the
  previous code; leave them (rule 06: drop in a later release).
- Data: `--reverse=<commit report>` per run, gated like the run. An account
  that already rotated stays rotated — its person chose that password.
- A person who cannot receive the code is not locked out by the default run
  (skipped as `EMAIL_UNROUTABLE`); one who is flagged and whose mail is
  delayed can request a new code after the 1-minute cooldown, twenty times a
  day.

## Deployment order

1. Deploy schema + code. Nothing changes for anyone: no account is flagged.
2. Confirm SES delivers to a `ke.com.pk` address from production (send one
   `VERIFY_EMAIL` code to a chosen pilot account and complete the flow).
3. `--usernames=<two pilots>` dry run → commit → both rotate → `--status`.
4. Tell K-Electric IT the date, that each `-ba` and `-op` account rotates
   separately and receives its own code, and send them the `EMAIL_UNROUTABLE`
   and `EMAIL_SHARED` lists to fix.
5. Full dry run → commit. `--status` daily until pending is zero.

## Not in scope

- Turning on login MFA (`mfa_enabled`) for K-Electric. `email_verified_at`
  makes that a safe follow-up for the accounts that completed this.
- Employee store accounts (`employee_credentials`) — K-Electric has none.
- Collecting real addresses for `ke-legacy.invalid` accounts — that is
  K-Electric's data to supply; the script reports who they are.

## Addendum — 2026-09-16, decisions and what was built

Decisions taken with the client:

- **Population: the mirrored `-ba`/`-op` accounts only** — `BRANCH_ADMIN` and
  `ORDER_PORTAL` with `external_source = 'KE_LOGISTICS'`. Head Office and
  portal-created accounts are not flagged. These are the script's defaults
  (`--roles`, `--external-sources`); nothing else needs passing.
- **Every verification email names the account it opens** — "This code is
  for your Branch Admin account (username imran-17655-ba). It will not work
  for any other account that uses this email address." — not only on shared
  addresses: every mirrored person's `-ba` and `-op` share one mailbox, so
  every K-Electric code needs the line. `lib/mfa.ts` carries an
  `OTPAccountContext` through to `lib/email.ts` for the `VERIFY_EMAIL` type;
  login codes are unchanged.
- **One known wrong address**: `imran-17655-op` is to carry
  `imrank@ke.com.pk`. That is a one-row correction done by hand before the
  run, not by the script; the dry run reports it as `EMAIL_UNROUTABLE` until
  it is done.

Built (all tested; see "How it was tested" below):

| Piece | Where |
|---|---|
| Migration: three nullable timestamps | `drizzle/20260916120000_add_email_verification_and_password_changed.sql` |
| API gate for a flagged session + allowlist | `proxy.ts` (`handleApiRequest`), `lib/password-change-pending.ts` |
| Email verification (send / verify), proof on the session | `lib/server/email-verification.ts`, `app/api/v1/users/me/email-verification/{send,verify}/route.ts` |
| Password change: proof consumed in the write transaction, current password, must differ | `lib/server/password-change.ts`, `app/api/v1/users/me/change-password/route.ts` |
| Session id from the JWT, never from the browser | `lib/server/current-session.ts` |
| Per-type OTP validity (`VERIFY_EMAIL` 10 min) and the account line in the mail | `lib/mfa.ts`, `lib/email.ts` |
| Three-step page | `app/(auth)/change-password/page.tsx` |
| Planner (pure) and script | `lib/forced-password-rotation.ts`, `scripts/force-password-rotation.ts`, `npm run rotate:passwords` |
| Audit vocabulary | `lib/server/auth-audit.ts` (`AUTH_EMAIL_VERIFICATION_*`, `AUTH_EMAIL_VERIFIED`, `AUTH_PASSWORD_CHANGED`, `AUTH_PASSWORD_CHANGE_FAILURE`, `AUTH_PASSWORD_ROTATION_FORCED/REVERSED`) |

Two details that differ from the plan above, both deliberate:

- The proof is kept in Postgres on `auth_sessions.email_verified_at`, not in
  Redis: it is transactional with the hash write and needs no second store.
  The script's cache clearing is a separate concern (the positive
  session-validation cache in Redis, `session-ok:<user id>`), done through
  `deleteCacheKeys` in `lib/cache-cli.ts` after the commit.
- A wrong current password keeps the proof (the person should not need a
  fresh code for a typo) but counts against the account's lockout budget,
  since this is the one place a live session can still guess at the
  password.

How it was tested (2026-09-16):

- `npm test` — 2,305 passing. New: `lib/forced-password-rotation.test.ts`
  (17), `lib/password-change-pending.test.ts`, `lib/validation/email.test.ts`,
  the API-gate cases in `proxy.test.ts` (the earlier assertion that the proxy
  never reads the token on API paths was removed on purpose — it now reads
  the signed claim for this one check and still leaves authorization to the
  handlers), and three contract cases in
  `lib/server/security-boundaries.test.ts`.
- `npm run test:integration` — **ran against `oneflowe_test`** (not skipped),
  10 files, 262 passing. New: `tests/integration/password-rotation.test.ts`
  (15): no session → 401; no proof → 403 and nothing written; unroutable
  address → 409 and no code generated; the mail names the account; wrong
  code stamps nothing; malformed and mass-assignment bodies → 400; proof
  lands on the entering session only; another session of the same person
  cannot spend it; wrong current password and new = old keep the proof;
  proof older than ten minutes refused; the change consumes the proof,
  clears the flag, stamps `password_changed_at`, bumps `session_version`,
  and cannot be repeated; the audit trail holds no code or password; the
  other account in the tenant is untouched.
- The script, end to end against a scratch tenant in the test database
  (a `-ba`/`-op` pair, two people on one address, a `ke-legacy.invalid`
  address, a `*_RETIRED` holder, a Head Office account, a twin in a second
  "demo" tenant): dry run planned exactly the four mirrored accounts and
  reported the shared address and the unroutable one; a wrong digest was
  refused; `--rollback-test` wrote nothing; `--commit` flagged four rows
  with the version bump and four audit rows, fingerprints unchanged, second
  run "nothing to do"; `--status` after one simulated completion showed
  1 completed / 3 pending; `--reverse` cleared the two untouched rows,
  skipped the rotated one (`ROTATED`) and the one another hand had moved
  (`SESSION_MOVED`), and never lowered `session_version`. Scratch rows
  deleted afterwards.
- `npm run typecheck`, `npm run lint` (0 errors; no new warnings),
  `npm run build` (with an HTTPS `NEXTAUTH_URL`, which the production env
  schema requires and the local `.env.local` does not provide).
