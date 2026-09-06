# 05 — API Standards

Applies to every handler under `app/api/v1/**/route.ts` and to every Server
Action. Route handlers are the security boundary; `proxy.ts` is not.

## Required order in a protected handler

1. **Rate limit** where the endpoint is auth-adjacent, expensive, or
   enumerable — `withRateLimit` from `lib/rate-limiter.ts`.
2. **Authenticate** — `getServerSession(authOptions)` / `getCurrentUser()` /
   `getRequestScope()`. No session → 401.
3. **Authorize** — check the `Permission` from `lib/permissions.ts` for the
   caller's role. Wrong permission → 403.
4. **Scope** — resolve the caller's organization/branch/group from the session,
   never from the request.
5. **Validate** — parse the body and query with Zod
   (`lib/server/mutation-validation.ts`). Reject unknown fields. Malformed →
   400 with a field-level message.
6. **Verify ownership** — the target row belongs to the caller's scope
   (`verifyResourceAccess()`, or a tenant predicate in the query). Not theirs →
   404 or 403, consistently.
7. **Do the work** — delegate to `lib/`. Wrap multi-row writes in a
   transaction.
8. **Audit** — record privileged and financial actions via
   `lib/global-logger.ts`.
9. **Respond** — only the fields the caller needs.

Steps 2, 3, 4 and 6 are not optional and are not replaced by a check in the UI
or in `proxy.ts`.

## Status codes

| Code | Meaning |
|---|---|
| 200 / 201 | Success |
| 400 | Validation failure — include the offending field |
| 401 | No or invalid session |
| 403 | Authenticated, not permitted |
| 404 | Not found, **or** exists but outside the caller's scope |
| 409 | Conflict / duplicate / state-machine violation |
| 429 | Rate limited — include `Retry-After` (`getRateLimitHeaders`) |
| 500 | Unexpected — generic message only |

Be deliberate about 403 vs 404 for out-of-scope resources: 404 avoids
confirming a resource exists. Whichever the endpoint chooses, apply it
consistently so the difference cannot be used to enumerate.

## Errors

All error responses go through `lib/error-handler.ts` (`handleError`,
`createUserFriendlyError`). Never return a raw exception message, an ORM error,
a SQL string, a stack trace, or an internal path. Log the detail server-side
with a correlation id; return the safe message.

## Responses

- Explicit field selection. Do not return a whole row by default —
  `orderSelectColumns` in `lib/order-select.ts` is the pattern.
- Price fields are filtered by `lib/price-visibility.ts`.
- Bound every list: a default page size and a maximum. An unbounded `limit` is
  a data-exfiltration path.
- Sort and filter keys come from an allowlist, never straight into SQL.
- Response shape is stable — 89 route handlers have clients; a field rename is
  a breaking change.

## Mutations

- Never spread a request body into an update. Pick fields explicitly.
- Reject privileged fields (`role`, `organizationId`, `branchId`, `status`, any
  price column) unless the caller's permission allows them.
- Sensitive mutations are idempotent or replay-protected. A retried approval
  must not approve twice.
- Multi-table writes are transactional. Read-then-write on budgets or inventory
  is a race — do the check and the write in the same transaction.

## Caching

`Cache-Control` on an authenticated response must not permit shared caching.
Redis caching via `lib/cache-utils.ts` uses tenant-scoped keys — a cache key
missing the tenant is a cross-tenant data leak.
