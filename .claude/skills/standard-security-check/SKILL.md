---
name: standard-security-check
description: Run the Engineering Development & Security Standard threat review over a change - authentication, authorization/RBAC, tenant isolation, injection, SSRF, XSS, path traversal, uploads, secrets, rate limiting, replay/idempotency, dependencies, database privilege, audit logging and business-logic abuse - and report findings by severity. Use before opening a PR, when reviewing security-sensitive code, or when asked to assess a change for vulnerabilities.
---

# Security Check

Review a change against the threat categories below. **Do not modify files
while reviewing** unless explicitly asked to fix what you find — report first.

## Scope the review

Start from the diff. For each changed file ask: does this touch a request
boundary, a database query, a permission check, a file, a secret, or money? If
yes, it needs a full pass.

## Threat categories

### Authentication

Weak flows; broken session handling; token leakage into logs, URLs, or client
payloads; missing expiry or revocation; account enumeration via differing error
messages or timings; credential stuffing; MFA bypass. Session identity comes
from `getServerSession` / `getCurrentUser` / `getRequestScope` — **never** from
the request body, query, or a header. The mirrored-account email-login guard
(`external_source`) and the session lifetime policy are load-bearing.

### Authorization / RBAC

IDOR/BOLA; missing function-level authorization; horizontal access to a peer's
record; vertical escalation; cross-tenant access; mass assignment. Check the
`Permission` from `lib/permissions.ts` is actually asserted server-side, not
just reflected in the UI or `proxy.ts`. Any endpoint writing a price must go
through `lib/pricing-access.ts` and appear in `lib/pricing-access.test.ts`.

### Tenant and resource isolation

For every query touching tenant data, **name the scope predicate**. If you
cannot point at it, it is missing. Check cache keys too — a Redis key without
the tenant is a cross-tenant leak.

### Input and injection

SQL injection (concatenation into a `sql` template, `sql.raw()`, a
user-supplied ORDER BY / LIMIT / filter key — these need an allowlist);
command injection; XSS (`dangerouslySetInnerHTML`, unvalidated `href`/`src`
schemes); SSRF (any server-side fetch of a user-supplied URL); path traversal
(S3 keys and file paths are generated server-side); unsafe parsing of CSV/XLSX
uploads; unbounded input.

### API security

Missing rate limit on auth-adjacent, expensive, or enumerable endpoints;
excessive data exposure (returning a whole row); weak or absent Zod validation;
unbounded pagination or filtering; unsafe methods; CORS; replay and duplicate
submission; missing idempotency on approvals, refunds, and budget changes.

### Secrets and cryptography

Hardcoded secrets in source, tests, or fixtures; secrets in logs or error
responses; `Math.random()` where `node:crypto` is required; weak hashing;
insecure key storage; sensitive data unencrypted in transit or at rest.

### Database and data

Runtime account holding schema-admin rights; missing tenant filters; unsafe or
irreversible migration; over-broad queries; audit rows that can be updated or
deleted; production data in a fixture or export committed to the repo.

### Files and uploads

Type validated by content not extension; size bounded; images sanitised through
`sharp`; the S3 bucket private and served through an authenticated route; no
`data:` URL written to a column; archive bombs on import paths.

### Dependencies and supply chain

New or unpinned dependencies; `latest` ranges; loosened `overrides`; a
vulnerable transitive package; a modified CI action; secrets reachable in build
logs.

### Business logic

Approval-workflow bypass; replayed transaction; manipulated amount, quantity,
or budget limit; race condition or TOCTOU on budget spend and inventory
(read-then-write outside a transaction); duplicate processing; an order state
transition that skips a state.

### Logging and auditability

Can a reviewer reconstruct who did a privileged action, when, and at what
price? Are correlation ids present? Do logs contain tokens, passwords, or full
PII? Use `maskSensitiveData()`.

## Protected endpoint test matrix

For each protected endpoint in the change, confirm tests exist for:

| Case | Expected |
|---|---|
| No session | 401 |
| Authenticated, lacks permission | 403 |
| Authorized | success |
| Resource in another tenant | denied (consistently 403 or 404) |
| Privilege-escalation attempt in the body | rejected |

## Severity

Judge exploitability, exposure, data sensitivity, and business impact — not the
scanner's label.

- **Critical** — authentication or authorization bypass, RCE, cross-tenant or
  mass data exposure, live exploitable compromise. Contain immediately.
- **High** — serious exploit with real confidentiality/integrity/availability
  impact. Fix this sprint.
- **Medium** — limited impact or harder to exploit. Planned sprint.
- **Low** — defence-in-depth. Track.

## Report

For each finding: severity, file and line, what an attacker does, what they
get, and the concrete fix. Then list the categories you checked and found
clean, so the reviewer knows what was covered. Separately list missing security
tests.

**Never weaken a security control to make a test or a build pass.** If a
requirement conflicts with a control, report the conflict.
