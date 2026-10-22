# OF-JOIN — Verify the applicant's email with a one-time code before the join form

Builds on `plans/OF-JOIN-email-domain-lock.md`, closing the risk it accepted:
"the domain constrains how an address is *spelled*, not who *owns* the mailbox.
Proving mailbox ownership would need an email verification step — a separate
change." This is that change.

## What is being asked

On the public join page (`/login` → "Join an organization"):

1. After the join code, the applicant is first asked for their **email** — the
   domain is already fixed to the organization's, as today.
2. Confirming the email **sends a one-time code** to it.
3. Only after the applicant **enters that code** is the join form shown.

## Acceptance criteria

* The page runs code → email → code from the email → form → sent. The form
  shows the verified address read-only; changing it means verifying again.
* `POST /api/v1/join/email-verification/request` `{ code, email }` resolves the
  organization from the join code, refuses an address outside its domain (400)
  or an organization without one (409) exactly as the submit does, and emails a
  6-digit code valid for 10 minutes. 202 with an opaque `challengeId`.
* `POST /api/v1/join/email-verification/verify` `{ challengeId, otp }` answers a
  single-use **proof** valid for 60 minutes, or one message for every rejection.
  Five wrong codes spend the challenge.
* `POST /api/v1/join/requests` — both forms — **requires** `emailVerification:
  { challengeId, proof }`. The proof must have been issued for this
  organization and for exactly the submitted address; otherwise 400 and nothing
  is stored. It is consumed in the same transaction that inserts the request, so
  a submission refused for another reason (a taken username, a full queue) keeps
  it, and a second submission with the same proof is refused.
* The request row records `email_verified_at`. Head Office editing a pending
  department request's email clears it, since the new address was never proven.

## Decisions

### 1. A table of its own, not `mfa_codes`

`lib/mfa.ts` keys every code on a `users.id`; an applicant has no account. The
self-service password reset solved the same shape with
`password_reset_challenges` (`lib/server/password-reset.ts`), and this copies
it: HMAC digests only — never the code, the proof **or the address** (an
abandoned verification leaves no personal data), attempt cap in a check
constraint, one live challenge per (organization, address) by partial unique
index, a resend consuming the previous one.

### 2. No account lookup on the request step, so no enumeration oracle

The request step never asks whether the address already has an account or a
pending request. Every in-domain address is sent a code. Whether the address is
taken is still decided by the submit, which flattens every identity conflict to
one message as before. Because nothing about accounts is consulted, the code is
sent before answering, and a delivery failure is reported honestly (503) —
there is nothing for timing or that answer to reveal.

### 3. A proof, not a session flag

There is no session on this page. The verify step returns a random 32-byte
proof (base64url) that the page holds in memory and sends with the submission;
only its digest is stored. 60 minutes because the department form is long; a
proof that lapses mid-form gets a message telling the applicant to verify again.

### 4. The proof is bound to the organization and the address

The submit recomputes the address digest from the address it is about to store
and the organization from the join code it just resolved. A proof for
`a@ke.example` cannot carry `b@ke.example`, and a proof obtained through one
organization's code cannot be spent on another's, even where two tenants share a
domain (K-Electric and K-E-Demo).

### 5. Abuse of the mail-out

Holding a valid join code lets a caller have codes sent to addresses at that
organization's domain. Bounded by: the caller's address (`otpSend`, 5 per 15
minutes), the join code (`login`, 15 per 15 minutes, as the other public join
routes), the address itself (`otpSend`), and 10 codes per address per day in the
database. The verify step is limited per caller and per challenge (`otpVerify`).

### 6. Head Office approval is unchanged

Approval does not re-check `email_verified_at`: requests submitted before this
change have none and must stay decidable, and Head Office may correct an address
(which clears it). The review shows whether the address was verified.

## Work

### Schema — `drizzle/20261025120000_join_email_verification.sql`

* `join_email_verifications` — `id uuid`, `organization_id` (→ `organizations`,
  `ON DELETE CASCADE`), `email_digest`, `code_digest`, `attempts` (0..5),
  `expires_at`, `verified_at`, `proof_digest`, `proof_expires_at`,
  `consumed_at`, `created_at`; checks mirroring the reset table; partial unique
  `(organization_id, email_digest) WHERE consumed_at IS NULL`.
* `organization_join_requests.email_verified_at timestamptz` — nullable.

Not RLS-enabled, like the other join tables: the runtime role's grants come
from default privileges (`docs/security/supabase-runtime-role-staging.sql`), and
the migration revokes `anon` and `authenticated` explicitly on top of
`20260709000000`'s default-privilege revoke.

Additive only. Rollback: `DROP TABLE join_email_verifications;
ALTER TABLE organization_join_requests DROP COLUMN email_verified_at;` after
reverting the code.

### Server

* `lib/server/join-email-verification.ts` — `issueJoinEmailCode`,
  `verifyJoinEmailCode`, `joinEmailProofIsLive` (cheap pre-check before the
  password is hashed), `consumeJoinEmailProof(tx, …)` (the control).
* `lib/organization-join.ts` — the user-facing messages.
* `lib/server/mutation-validation.ts` — `joinEmailCodeRequestSchema`,
  `joinEmailCodeVerifySchema`, `emailVerification` on both submit schemas.
* `lib/server/organization-join.ts` / `organization-join-department.ts` — the
  insert transaction consumes the proof and stamps `email_verified_at`.
* `lib/server/organization-join-department-edit.ts` — a changed email clears it.
* `lib/server/auth-audit.ts` — `AUTH_JOIN_EMAIL_CODE_SENT`,
  `AUTH_JOIN_EMAIL_VERIFIED`, `AUTH_JOIN_EMAIL_VERIFICATION_FAILURE`.

### UI

* `components/join/join-email-verification-step.tsx` — email, then code, with
  resend (60 s cooldown) and "use a different email".
* `app/join/page.tsx` — the new step between the code and the form.
* Both forms take `lockedEmailLocalPart` and render the address read-only.
* The join request row and the department review show "Email verified".

## Security

* **Authentication** — public by design, like the other join routes; it creates
  no account and grants nothing. The proof only unlocks submitting a *pending*
  request, which Head Office still decides.
* **Tenant isolation** — no organization id is accepted; the tenant comes from
  the join code on the request and the submit, and the proof is bound to it.
* **Enumeration** — Decision 2; one rejection message on verify; no attempt
  counts returned.
* **Secrets** — code and proof from `node:crypto`; stored as HMAC-SHA256 under
  `NEXTAUTH_SECRET` with a domain-separation prefix; compared in constant time;
  never logged or audited.
* **Replay** — the proof is single-use, consumed by a conditional `UPDATE … WHERE
  consumed_at IS NULL` in the insert's transaction.

## Tests

* Unit — `lib/server/join-email-verification.test.ts` (digest binding and
  domain separation), schema tests, route tests for both endpoints, the
  verification step component, the page flow, the forms' locked email.
* Contract — `lib/server/organization-join-contract.test.ts`: the new routes
  resolve the tenant from the code / never read an organization id, are rate
  limited, and the submit checks the proof before hashing and consumes it inside
  the creation transaction.
* Integration — `tests/integration/join-email-verification.test.ts`: send →
  verify → submit for both forms; wrong code ×5 spends it; expired code and
  proof; proof for another address or organization; replay; a refused
  submission keeps the proof; resend invalidates the old code; daily limit;
  Head Office's email edit clears `email_verified_at`. Existing join suites
  gain a helper that obtains a proof.

## Rollout

Apply `20261025120000` before deploying: the submit selects the new table and
writes the column. A join page loaded before the deploy will be refused at
submit ("verify your email") — reloading it fixes that.

## Verification — as run (2026-10-19)

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors; 7 warnings, none in a file this change touches logically |
| `npm test` | 431 files; one failure found (`mass-assignment.test.ts` flagged a `...input.emailVerification` spread) and fixed by picking the two fields; the guard and the join tests re-run green |
| `npm run test:integration` (affected suites) | `join-email-verification` 19/19, plus the four join suites, both write sweeps and the composite-key check: 210 passed, every file `running against oneflowe_test` |
| `npm run db:migrate:test` | applied `20261025120000_join_email_verification` |
| `npm run db:validate` | clean |
| `npm run build` (HTTPS `NEXTAUTH_URL`) | succeeded; both routes built |
| Playwright join journeys | the department sign-up through email verification and Head Office approval passed; the domain spec's refuse-@-then-verify-then-submit passed; on re-run the standard journey's join, verification and approval passed. Failures were cold-server API timeouts and one hydration reload, plus the standard journey's final sign-in, which uses the bare username although accounts have carried the organization prefix since the username-prefix change — a pre-existing spec defect, untouched here |

Mutation check: with the proof check and the in-transaction spend disabled,
five integration cases fail.
