---
name: standard-api-endpoint
description: Build or modify a protected API route handler or Server Action to the Engineering Development & Security Standard - rate limit, authenticate, authorize, scope to tenant, validate with Zod, verify ownership, transact, audit, and shape the response - with the required 401/403/success/cross-tenant/escalation tests. Use when adding or changing anything under app/api/v1/ or any Server Action.
---

# Protected API Endpoint

A route handler is the security boundary. `proxy.ts` role routing and hidden UI
controls are not. A Server Action is a public HTTP endpoint and follows this
skill exactly as a route handler does.

## Before writing

Read a comparable existing handler under `app/api/v1/` — the conventions here
are settled and a new endpoint should be recognisable as a sibling of the old
ones. Identify: which `Permission` governs this action, what tenant scope
applies, which table is touched, and whether the action is financial or
privileged (and therefore auditable).

## The order

### 1. Rate limit

`withRateLimit` from `lib/rate-limiter.ts` for anything auth-adjacent,
expensive, or enumerable. Return 429 with `getRateLimitHeaders`.

### 2. Authenticate

`getServerSession(authOptions)`, or `getCurrentUser()` / `getRequestScope()`
from `lib/auth.ts`. No session → 401. Never read the caller's identity, role,
organization, or branch from the request.

### 3. Authorize

Check the `Permission` from `lib/permissions.ts`. Missing → 403. Never inline a
`role === "SUPER_ADMIN"` comparison where a permission exists. Price writes at
any tier go through `lib/pricing-access.ts` — and the route is added to the
list in `lib/pricing-access.test.ts`.

### 4. Scope

Resolve organization / branch / group from the session:
`getRequestScope()`, `resolveScopedBranchIds()`,
`lib/organization-report-scope.ts`. This scope, not a client value, goes into
the query.

### 5. Validate

Parse body and query params with Zod (`lib/server/mutation-validation.ts`).
Reject unknown fields rather than ignoring them. Bound every list parameter —
a default page size and a maximum. Sort and filter keys come from an allowlist,
never straight into SQL. Invalid → 400 naming the field.

### 6. Verify ownership

The target row belongs to the caller's scope — `verifyResourceAccess()` or an
explicit tenant predicate in the query. Fetching by an id from the request and
returning the row is an IDOR. Out of scope → 404 or 403, applied consistently
across the API so the difference cannot be used to enumerate.

### 7. Do the work

Delegate to `lib/`. The handler holds no business rules. Multi-row writes and
any read-then-write (budget spend, inventory, approval) run in a transaction —
a check followed by an unguarded update is a TOCTOU bug that shows up as an
over-spent budget or negative stock.

### 8. Audit

Privileged and financial actions get an audit record via
`lib/global-logger.ts` (`systemLogs`, `groupAuditLogs`, `orderApprovals`) —
who, what, when, at what value. Audit rows are append-only.

### 9. Respond

Explicit field selection; never a whole row by default (`orderSelectColumns` is
the pattern). Filter price fields through `lib/price-visibility.ts`. Errors go
through `lib/error-handler.ts` — never a raw exception, ORM error, SQL string,
stack trace, or internal path. `Cache-Control` on an authenticated response
must not permit shared caching; Redis keys are tenant-scoped.

## Mutation rules

- Never spread a request body into an update. Pick fields explicitly.
- Reject privileged fields — `role`, `organizationId`, `branchId`, `status`,
  any price column — unless the caller's permission allows them.
- Sensitive mutations are idempotent or replay-protected. A retried approval
  must not approve twice.

## Status codes

200/201 success · 400 validation · 401 no session · 403 not permitted ·
404 not found or out of scope · 409 conflict or state-machine violation ·
429 rate limited · 500 unexpected, generic message only.

## Required tests

| Case | Expected |
|---|---|
| No session | 401 |
| Authenticated, lacks permission | 403 |
| Each authorized role | success |
| Resource in another tenant | denied |
| Privileged field in the body | rejected, not silently applied |
| Duplicate submission | no double effect |
| Invalid / oversized input | 400 naming the field |

Integration tests in `tests/integration/` where the handler touches the
database. If a contract test covers this route category
(`lib/server/security-boundaries.test.ts`, `lib/pricing-access.test.ts`), add
the route to its list — a route missing from that list is silently unprotected.

## Report

State the permission enforced, the scope predicate used, what validation
rejects, whether the action is audited, and which of the test cases above now
exist.
