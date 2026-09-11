# 01 — Architecture

## Layers

Keep these responsibilities separate. Do not take cross-layer shortcuts without
recording the reason in the plan.

| Layer | Location | Responsibility |
|---|---|---|
| Route handlers | `app/api/v1/**/route.ts` | Auth, input parsing/validation, calling domain logic, shaping the response. No business rules. |
| Domain / business logic | `lib/**` | Pure, testable rules. No `NextRequest`, no `NextResponse`. |
| Server-only domain | `lib/server/**` | Domain logic that legitimately needs server secrets or DB access. Marked with `import "server-only"`. |
| Persistence | `db/schema.ts`, `drizzle/` | Schema and migrations. |
| UI | `app/(portal)/**`, `app/shop/**`, `components/**` | Presentation and interaction only. |
| Edge routing | `proxy.ts` | Role-based route gating. Convenience and UX, **not** the authorization boundary. |

## Rules

- **Business logic belongs in `lib/`, not in a route handler and not in a
  component.** A rule that lives in a route handler cannot be unit-tested and
  will be reimplemented differently in the next route that needs it.
- Route handlers stay thin: authenticate, authorize, validate, delegate,
  respond.
- Pure logic must stay importable without a database. Anything needing
  Postgres, Redis, or the network belongs behind `lib/server/` and gets an
  integration test rather than a unit test.
- `proxy.ts` gates navigation by role. It is **never** sufficient authorization
  — every route handler re-checks server-side.
- Before changing a shared module (`lib/permissions.ts`, `lib/order-status.ts`,
  `lib/server/effective-price.ts`, `db/schema.ts`), find every caller and every
  test that depends on it. Grep for the exported symbol, not just the filename.
- Material architectural changes are documented in the plan before they are
  written.

## Multi-tenancy

The hierarchy is `organizations` → `branches` → `users`, with a group tier used
for pricing and portal scoping. Every query that reads tenant data must be
scoped. Use the existing scope resolvers — `getRequestScope()` in `lib/auth.ts`,
`resolveScopedBranchIds()` in `lib/server/multi-branch-scope.ts`,
`lib/organization-report-scope.ts` — rather than assembling a `where` clause by
hand.
