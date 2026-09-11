# Authentication audit trail and account lockout

Two controls added together because they answer the same audit question: *what
happened on the sign-in path, and what stops an attacker repeating it?*

Before this, the authentication path wrote only `console` output, and the only
brute-force defence was the login rate limiter — which is keyed partly on the
client address, so rotating source addresses granted a fresh attempt budget
against the same account.

## Control mapping

| Requirement | Control |
|---|---|
| PCI DSS 10.2.1.1–10.2.1.5 | Every sign-in outcome is a `system_logs` row |
| PCI DSS 8.3.4 | At most 10 attempts. **Lock duration deviates** — see [Configuration](#configuration) |
| SOC 2 CC7.2 | Queryable, retained authentication event history |
| ISO 27001 A.8.15 | As above |

## Authentication audit trail

`lib/server/auth-audit.ts` writes to the existing `system_logs` table with
`resource_type = 'auth'`. That table is used rather than `audit_logs` because
its `user_id` is a plain varchar: an authentication event may reference an
employee principal (`emp_42`) or no known account at all, neither of which fits
the `audit_logs` foreign key to `users.id`.

### Events

| Action | Meaning |
|---|---|
| `AUTH_LOGIN_SUCCESS` | A session was issued |
| `AUTH_LOGIN_FAILURE` | Attempt refused; see `details.reason` |
| `AUTH_MFA_CHALLENGE` | Password accepted, OTP outstanding |
| `AUTH_MFA_FAILURE` | OTP rejected |
| `AUTH_ACCOUNT_LOCKED` | This attempt crossed the lockout threshold |
| `AUTH_LOCKOUT_BLOCKED` | Attempt refused because the account was already locked |
| `AUTH_SESSION_REVOKED` | Sign-out completed and the registry record was revoked |

`details.reason` is a closed set (`unknown_account`, `invalid_password`,
`user_inactive`, `organization_inactive`, `branch_inactive`,
`network_restricted`, `network_unavailable`, `account_locked`, `mfa_required`,
`mfa_invalid`, `mfa_not_enrolled`). It is closed so the trail stays
aggregatable and so no raw database error text can reach it.

Each row also carries the resolved client address and user agent, the attempted
identifier, and the tenant scope where one was established.

### Two deliberate properties

**Writes are best-effort.** A failed audit write is logged to the process log
but never denies an otherwise valid login. Availability of sign-in was judged
more important than refusing to proceed unaudited; the loud `[AuthAudit]` error
is what alerting should watch for, since silently losing the trail is the
outcome worth detecting.

**Credentials never reach it.** No password, OTP, or session token is passed to
`recordAuthAuditEvent`. The attempted *identifier* is recorded, truncated to 128
characters, because correlating repeated attempts on one account is the point.

## Account lockout

The decision logic is pure and lives in `lib/auth-lockout-policy.ts`; the
database writers are in `lib/server/auth-lockout.ts`. This mirrors the existing
`lib/session-policy.ts` / `lib/server/session-policy.ts` split.

State is three columns on both `users` and `employee_credentials`:
`failed_login_attempts`, `last_failed_login_at`, `lockout_until`.

### Why Postgres rather than Redis

A Redis outage would silently disable the control, and an auditor needs the
locked state to be durable and inspectable. The counters therefore live beside
the account they protect.

### Behaviour

- Checked **before** the password is verified, so a locked account cannot be
  used as an oracle for whether a guess was correct, and every attempt against
  a locked account costs the same.
- Counted **per account**, which is precisely what the rate limiter cannot do.
  Both controls remain in force; they defend different things.
- The increment is a single `UPDATE` whose right-hand sides all read the
  pre-update row, so concurrent attempts cannot lose an increment.
- The counter resets as the lock is applied, so releasing a lock restores a full
  budget rather than leaving the account one attempt from re-locking.
- An expired `lockout_until` simply stops matching — no cleanup job is needed.
- OTP failures count against the same budget. `lib/mfa.ts` keeps its own
  verification cooldown; both apply.
- Bad or unparseable data evaluates as *unlocked*, so it can never strand a
  legitimate account.

### Release

An account is released by any of:

1. Waiting out `lockout_until` (default 5 minutes).
2. A successful authentication, which clears the counters.
3. An administrator resetting the password (`PATCH /api/v1/users/[id]`) — the
   "identity confirmed" branch of PCI DSS 8.3.4.
4. The user completing a password change.

### Configuration

| Variable | Range | Default |
|---|---|---|
| `AUTH_LOCKOUT_THRESHOLD` | 3–10 | 5 |
| `AUTH_LOCKOUT_DURATION_MINUTES` | 5–1440 | 5 |

The **ranges are the control**: a value outside them is rejected at startup,
so a misconfigured secret store cannot relax the policy — the same approach
`INACTIVITY_TIMEOUT_MINUTES` already uses. Bounds are defined once in
`lib/auth-lockout-policy.ts` and imported by env validation.

> **Known deviation from PCI DSS 8.3.4.** The standard requires a lockout of at
> least thirty minutes. The duration floor here is **five minutes**, lowered
> deliberately so a user who mistypes a password is not shut out of the portal
> for half an hour. The attempt threshold (at most ten) still conforms, the lock
> is still applied, audited as `AUTH_ACCOUNT_LOCKED`, and still refuses the
> password while it holds — but an attacker's mandatory wait between bursts is
> six times shorter than the standard assumes. Restore
> `LOCKOUT_DURATION_MINUTES_MIN = 30` in `lib/auth-lockout-policy.ts` if this
> platform is ever brought into scope for a PCI assessment.

### Local development

Neither brute-force control runs under `next dev`. `lib/auth-brute-force-mode.ts`
exempts that one environment, which switches off both the `login` rate limiter
and the account lockout — including a lock already recorded in the database, so
an account locked elsewhere is still usable against a local copy. `next build`
sets `NODE_ENV=production`, so every deployed build enforces both; an unset or
unrecognised `NODE_ENV` also enforces.

## Sign-in page behaviour

A locked account surfaces as `ACCOUNT_LOCKED`, added to the sanitizer allowlist
in `app/api/auth/[...nextauth]/route.ts`.

One consequence worth knowing: the sign-in page retries the employee provider
when the staff provider returns `CredentialsSignin`. Because `ACCOUNT_LOCKED` is
a distinct code, a locked staff account no longer falls through to that retry.

The rate-limit reset condition was also narrowed. It previously treated *any*
non-`CredentialsSignin` error as proof of valid credentials and refunded the
brute-force budget; a lockout is raised before the password is checked, so it
must not qualify. The qualifying errors are now enumerated explicitly.

## Deployment

1. Run `npm run db:migrate` (`20260823130000_add_auth_lockout`). Additive only —
   new nullable columns plus defaults, safe to apply ahead of the deploy.
2. The migration grants `INSERT` on `system_logs` to `oneflowe_runtime` where
   that role exists, since the audit path writes before any principal is
   established. Deployments not using the staged least-privilege role are
   unaffected.
3. Optionally set the two variables above. The defaults are compliant.

No backfill is required; every account starts at zero attempts and unlocked.

## Queries for an auditor

```sql
-- Failed sign-ins in the last 24 hours, by reason
SELECT details->>'reason' AS reason, count(*)
FROM system_logs
WHERE resource_type = 'auth' AND success = false
  AND timestamp > now() - interval '24 hours'
GROUP BY 1 ORDER BY 2 DESC;

-- Accounts locked in the last 7 days
SELECT timestamp, user_id, user_email, ip_address, details->>'lockoutUntil'
FROM system_logs
WHERE action = 'AUTH_ACCOUNT_LOCKED' AND timestamp > now() - interval '7 days'
ORDER BY timestamp DESC;

-- Currently locked accounts
SELECT id, email, failed_login_attempts, lockout_until
FROM users WHERE lockout_until > now();

-- One account's full authentication history
SELECT timestamp, action, success, details->>'reason' AS reason, ip_address
FROM system_logs
WHERE resource_type = 'auth' AND resource_id = 'jrivera'
ORDER BY timestamp DESC;
```

## Tests

- `lib/auth-lockout-policy.test.ts` — the pure rule: boundaries, expiry,
  counter reset, that the attempt threshold stays inside PCI DSS 8.3.4, and
  that the duration floor holds at its chosen non-zero value.
- `lib/auth-brute-force-mode.test.ts` — that only `development` is exempt, and
  that an unset or unrecognised `NODE_ENV` still enforces.
- `lib/auth-options-signin.test.ts` — the sign-in path across all providers:
  which event each outcome records, that a locked account is refused before
  `verifyPassword` is called, that failures are counted against the account,
  and that no password reaches an audit event.

## Known gaps

Retention and tamper-evidence for `system_logs` are not addressed here. PCI DSS
10.5.1 wants 12 months (3 immediately available) and 10.3.2 wants the records
protected from modification. Both are deployment concerns — retention policy and
database privileges — rather than application code.
