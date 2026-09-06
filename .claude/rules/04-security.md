# 04 — Security

Security is a design requirement, not a final phase. Treat every item below as
a question to answer for the change in front of you, not a checklist to tick.

## Two rules that override everything else

1. **Frontend controls are not security controls.** A hidden button, a
   disabled input, a `proxy.ts` redirect, and a conditional render are UX.
   Every one of them must have a server-side check behind it.
2. **Never hardcode a secret.** No credentials, tokens, keys, or connection
   strings in source, tests, fixtures, or committed config. `.gitleaksignore`
   holds known false positives only.

## Authentication

- Session comes from `getServerSession(authOptions)` / `getCurrentUser()` /
  `getRequestScope()`. Never trust a user id, role, organization id, or branch
  id sent in a request body, query string, or header.
- Watch for: broken session handling, token leakage into logs or URLs, missing
  expiry/revocation, account enumeration through differing error messages or
  response timings, credential stuffing, MFA bypass.
- The session model here is deliberate — encrypted JWT cookies, a per-browser
  revocation registry, a 1–15 minute tenant idle timeout, a fixed 8-hour
  absolute lifetime (`lib/session-policy.ts`, `lib/session-coordination.ts`).
  Do not extend a lifetime or relax a check to resolve a "user keeps getting
  logged out" complaint without a documented decision.
- Mirrored accounts (`external_source` set) **cannot sign in by email**, only by
  username. That guard is load-bearing because one shared email maps to several
  role accounts. Never relax it.

## Authorization / RBAC

- Permissions are `resource:action` and live in `lib/permissions.ts`
  (`Permission` enum, `PERMISSION_DEFINITIONS`, `ROLE_TEMPLATES`), stored in
  `rolePermissions`. Check them there. **Never inline a role comparison in a
  component or a route handler** when a permission exists.
- Watch for: IDOR/BOLA, missing function-level authorization, horizontal access
  (peer's record), vertical escalation (acting above one's role), cross-tenant
  access, mass assignment.
- **Ownership is checked, not assumed.** Fetching a row by an id from the
  request and returning it is an IDOR unless the row's organization/branch was
  verified against the caller's scope — `verifyResourceAccess()` in
  `lib/auth.ts`, or an explicit tenant predicate in the query.
- **Mass assignment**: never spread a request body into an update. Pick fields
  explicitly. A body carrying `role`, `organizationId`, `branchId`, `status`,
  or any `*price*` field must be rejected, not silently applied.
- **Pricing is Super Admin only, at every tier.** Any endpoint writing a price
  column goes through `lib/pricing-access.ts` (`canMutatePrices`,
  `rejectPriceFieldsForRole`) and must be added to the route list in
  `lib/pricing-access.test.ts`.

## Tenant and resource isolation

Every read and every write of tenant data carries a scope predicate. The most
common serious bug in a multi-tenant system is a query that forgot one. When
reviewing a query, name the tenant filter out loud; if you cannot, it is
missing. Organization 10 (K-Electric) and organization 2 (`K-E-Demo`) share
email addresses — scripts touching one must never touch the other.

## Input validation and injection

- Validate every untrusted input with Zod at the boundary. Reject unknown
  fields rather than ignoring them.
- **SQL injection**: Drizzle's query builder is parameterized and safe. Raw
  `sql` template literals are safe when values are interpolated as parameters
  (`sql\`... ${value}\``) and **unsafe** when a string is concatenated into the
  template or passed through `sql.raw()`. Never build a fragment from user
  input — especially an ORDER BY column, a LIMIT, or a filter name. Map
  user-supplied sort/filter keys through an allowlist.
- **XSS**: React escapes by default. `dangerouslySetInnerHTML` requires a
  documented reason and sanitization. Never render user content into a `href`,
  `src`, or inline style without validating the scheme.
- **SSRF**: any server-side fetch to a URL derived from user input needs an
  allowlist of host and scheme. This applies to image URLs, webhooks, and the
  legacy platform sync.
- **Path traversal**: S3 keys and file paths are generated server-side, never
  taken from the client. `lib/server/image-storage.ts` owns key generation and
  validation — use `isDataUrl` / `isStoredImagePath` rather than string checks.
- **Unsafe deserialization / parsing**: CSV and XLSX imports are untrusted
  input. Bound row counts and cell sizes; a spreadsheet is an attack surface.
- **Command injection**: no shelling out with interpolated user input.

## API security

- Rate limit anything authentication-adjacent, expensive, or enumerable —
  `withRateLimit` from `lib/rate-limiter.ts`.
- Return only the fields the caller needs. Do not return a whole row because it
  is convenient — password hashes, tokens, internal ids, other tenants'
  aggregates. Price visibility is governed by `lib/price-visibility.ts`.
- Bound pagination and filtering. An unbounded `limit` is a denial-of-service
  and a data-exfiltration path.
- Sensitive state-changing operations (order approval, refund, budget change)
  need replay protection / idempotency. Watch for double submission.
- CORS stays closed unless a caller genuinely needs it.
- Never expose a stack trace, an ORM error, or an internal path to a client.

## Uploads and files

Validate type by content, not by extension. Bound size. Images are sanitised
through `sharp` before storage. The S3 bucket is private and stays private;
files are streamed back through an authenticated route. Never write a `data:`
URL into a column.

## Secrets and cryptography

Secrets come from the environment (`.env.local` locally, GitHub Actions secrets
in CI, the platform's secret store in production). Use the platform's default
AWS credential chain rather than credentials in application code. Use
established primitives — `bcrypt` for passwords, `node:crypto` `randomBytes`
for tokens. Never `Math.random()` for anything security-bearing. Never log a
token, a session value, or a password; `maskSensitiveData()` exists for this.

## Database

Least-privilege identities, separated by purpose: the application runtime uses
`DATABASE_URL`, and migrations use `MIGRATION_DATABASE_URL`. The runtime
account must not hold schema-admin rights. See rule 06.

## Dependencies and supply chain

`npm ci` against the committed lockfile. `npm audit --audit-level=high` gates
CI. Pin versions; do not add `latest`. Review a new dependency's provenance
before adding it.

## Logging and auditability

Privileged and financial actions are auditable — `lib/global-logger.ts`,
`systemLogs`, `groupAuditLogs`, `orderApprovals`. A reviewer must be able to
reconstruct who approved what, when, and at what price. Logs carry correlation
ids and never carry secrets or full PII.

## Business logic

Watch for: approval-workflow bypass, replayed transactions, manipulated amounts
or budget limits, race conditions and TOCTOU on budget spend and inventory,
duplicate processing, order state-machine transitions that skip a state.
Concurrent budget and inventory changes belong in a transaction with the right
isolation, not in a read-then-write pair.

## Protected endpoint tests

Every protected endpoint is tested for: unauthenticated → 401; authenticated
but unauthorized → 403; authorized → success; cross-tenant access → denied;
privilege escalation attempt → denied.

**Never weaken a security control to make a test pass.**
