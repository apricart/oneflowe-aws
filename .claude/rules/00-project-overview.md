# 00 — Project Overview

Derived from the Engineering Development & Security Standard v1.0. Adapted for
OneFlowe: Next.js App Router + TypeScript + Drizzle/Postgres + NextAuth.

## Before changing code

Read, in this order, whatever is relevant to the change:

1. `CLAUDE.md` — architecture, the pricing rules, the K-Electric import rules.
2. The module you are changing **and its `.test.ts` sibling**. Tests in this
   repo live beside the code, so the test file is the fastest statement of
   what the module currently guarantees.
3. `db/schema.ts` when the change touches persisted data.
4. `lib/permissions.ts` and `proxy.ts` when the change touches who may do what.
5. The plan under `plans/` when one exists for this ticket.

## Working rules

- Prefer an existing pattern over a new abstraction. This codebase already has
  a settled way to do most things — error handling (`lib/error-handler.ts`),
  rate limiting (`lib/rate-limiter.ts`), pricing (`lib/server/effective-price.ts`),
  RBAC (`lib/permissions.ts`), audit (`lib/global-logger.ts`). Route through
  them rather than reimplementing.
- Non-trivial work gets a plan at `plans/<JIRA-ID>-<feature>.md` before
  implementation. Non-trivial means: a new endpoint, a schema change, a change
  to authorization or pricing, or a change touching more than a couple of
  modules.
- This is a **live production application** serving real tenants. Assume every
  table has real rows and every endpoint has real callers.
- Never run destructive or data-mutating scripts against a real database to
  test a change. The import/sync scripts under `scripts/` are dry-run by
  default and require a printed plan digest to commit — do not bypass that.

## Next.js version note

`AGENTS.md` warns that this Next.js version differs from training data. When
using a framework API you have not verified in this repo, check
`node_modules/next/dist/docs/` or an existing usage in `app/` first.
