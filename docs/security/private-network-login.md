# Private network login (per-tenant IP allowlist)

A Super Admin can restrict an organization so its members may only authenticate
from addresses that organization owns. It is configured per organization, on
both the Create Company and Edit Company dialogs.

## Prerequisite: the resolved client address must be trustworthy

**This control is only as strong as `RATE_LIMIT_TRUST_PROXY_HOPS`.**

The client address comes from `resolveTrustedClientIp`, the same resolver rate
limiting uses: `CloudFront-Viewer-Address` first, otherwise the entry in
`X-Forwarded-For` selected by counting `RATE_LIMIT_TRUST_PROXY_HOPS` back from
the right, otherwise `X-Real-IP`.

If that hop count is too large for the real topology, the selected entry is one
a caller can write themselves, and anyone could present an allowed address in a
header. Confirm the value against the actual CDN/load-balancer chain **before**
enabling this feature for any tenant. Rate limiting has the same dependency, so
a wrong value is already a bug — this feature raises its severity.

## Data model

| Object | Purpose |
|---|---|
| `organizations.private_network_login_enabled` | Per-tenant toggle, default `false` |
| `organization_allowed_ips` | One row per allowed network, `ON DELETE CASCADE` |

Addresses are stored already masked to their network address plus an explicit
prefix length (a single host is `/32` or `/128`), so matching is a pure prefix
comparison and one network cannot be stored under two spellings. Parsing,
masking, and matching all live in `lib/security/ip-allowlist.ts`, which has no
Node built-ins so the browser, the API, and the auth callbacks share one
implementation.

Accepted input: IPv4 and IPv6 hosts (`203.0.113.7`, `2001:db8::1`) and CIDR
ranges (`203.0.113.0/24`, `2001:db8::/32`). An IPv4-mapped IPv6 client such as
`::ffff:203.0.113.7` matches the IPv4 entry an administrator typed.

## Where it is enforced

1. **Sign-in** — all four credential providers, after the password and the
   account/org/branch status checks and before the MFA branch. Failing here
   raises `NETWORK_RESTRICTED`, which the login page renders as
   "Please log in from your organization's network."
2. **Live sessions** — the NextAuth `session` callback re-checks on every
   session read, so a session that leaves the network is revoked rather than
   surviving to its idle or absolute deadline. The activity-renewal path checks
   too, so such a session can never extend its idle deadline.

The check deliberately sits **outside** the Redis session-validation cache,
which is keyed by user and would otherwise mask an address change for its whole
TTL. The tenant policy itself is cached for 30 seconds, so a steady-state
session read costs one Redis read and no database round-trip.

Ordering note: the sign-in check runs after password verification, matching
`ORGANIZATION_INACTIVE` and `BRANCH_INACTIVE`. An anonymous caller therefore
learns nothing about which organizations are restricted.

## Decision matrix

| Condition | Result |
|---|---|
| Role is `SUPER_ADMIN` | Allowed — always exempt |
| Principal has no organization | Allowed |
| Tenant toggle is off | Allowed |
| Client address matches an entry | Allowed |
| Client address does not match | **Denied** |
| Client address unknown or unparseable | **Denied** (fails closed) |
| Policy cannot be read (database/Redis down) | Retryable "unavailable", never a silent allow or a logout |
| Schema missing (code deployed before the migration) | Allowed, with a loud error log — see below |
| Toggle on with an empty allowlist | Allowed, with a loud error log (see below) |

A missing column or table (SQLSTATE `42703`/`42P01`) is treated as "feature not
installed" rather than an outage: without the schema the restriction cannot be
enabled for any tenant, so nothing is bypassed, while failing closed there would
lock every tenant out during a routine deploy window. Every other database error
still reports "unavailable".

`SUPER_ADMIN` is exempt so a mistaken allowlist can never lock the platform
owner out of the tool needed to repair it. Today super admins also have no
`organizationId`, so this mostly formalizes existing behavior.

Enabled-with-empty-allowlist is unreachable through the API: the toggle cannot
be saved without at least one address, and saving an empty list clears the
toggle. It is reachable only by editing rows directly, and denying there would
lock out every member with no in-app way back. Anyone able to edit those rows
could clear the toggle anyway, so it allows and logs instead.

## Recovering from a lockout

1. Sign in as a `SUPER_ADMIN` (never restricted) and correct or disable the
   allowlist from Edit Company.
2. If no super admin is available, clear the flag directly:
   ```sql
   UPDATE organizations SET private_network_login_enabled = false WHERE id = <org_id>;
   ```
   Cached policy expires within 30 seconds; `invalidateByPrefix('org-network-policy')`
   makes it immediate.

## Deliberately not covered

- **`/api/v1/mfa/login/send-otp`** is unchanged. It is username-only by design
  (generic response, no user enumeration), and an OTP is useless on its own —
  the `mfa-credentials` provider still refuses the login. A restricted user can
  at most trigger an already rate-limited OTP email.
- **Edge middleware** does not check addresses; it cannot reach the database.
  Enforcement happens on every session read instead, which covers all API
  traffic and server-rendered pages, and the client session guard polls every
  120 seconds.
