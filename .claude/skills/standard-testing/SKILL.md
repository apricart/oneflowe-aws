---
name: standard-testing
description: Write and run tests to the Engineering Development & Security Standard - choose the right Vitest project, cover happy path, validation, boundaries, exceptions, authorization, tenant isolation, dependency failure and idempotency, and verify the integration suite actually ran. Use when adding tests, when a change needs coverage, or when asked whether something is tested.
---

# Testing

## Pick the right project

| | Unit & contract | Integration | E2E |
|---|---|---|---|
| Command | `npm test` | `npm run test:integration` | `npm run e2e` |
| Location | beside the code, `lib/**/*.test.ts` | `tests/integration/**` | `tests/e2e` |
| Needs | nothing | disposable Postgres | running app |

Anything requiring Postgres, Redis, or the network goes in the integration
project, so `npm test` stays runnable with nothing installed. Read
`tests/README.md` before setting up integration runs.

**The integration suite skips silently and still passes without
`TEST_DATABASE_URL`.** Check stderr. Never report integration coverage you did
not observe run, and never point `TEST_DATABASE_URL` at the application
database — `.env.local` is deliberately not read for it.

## Decide what to cover

Work through the change and ask which apply:

- **Happy path** — the intended use, with realistic data.
- **Validation** — missing field, wrong type, empty string, oversized input,
  unknown extra field.
- **Boundaries** — zero, one, maximum, exactly-at-limit, one past the limit.
  For money: zero, negative, rounding at the cent.
- **Exceptions** — what the caller sees when the dependency throws.
- **Authorization** — for each role: allowed roles succeed, others get 403,
  no session gets 401.
- **Tenant isolation** — a caller in organization A cannot read or write
  organization B's row. This is the test most often missing.
- **Database behaviour** — constraints, cascades, transaction rollback,
  concurrent modification of budget or inventory.
- **Dependency failure** — S3, SES, Redis, the legacy platform: unavailable,
  slow, returning an error.
- **Duplicates and retries** — submitting twice must not approve twice, charge
  twice, or double-decrement stock.

## Write the test

- **Behavioural first** — import the module and call it. Prefer these.
- **Contract tests** where the guarantee is structural — "every route that
  writes a price goes through `lib/pricing-access.ts`". When you add a route in
  such a category, add it to that test's route list; a route missing from the
  list is silently unprotected.
- Assert the behaviour, not the implementation. A test that mirrors the code
  line by line will pass a rewritten bug.
- One reason to fail per test. Name it after the behaviour, not the function.
- No shared mutable fixtures, no order dependence, no real wall-clock
  dependence. Deterministic data.
- Server modules under `lib/server/` are importable in tests — both configs
  alias `server-only` to an empty module.

## Run

Targeted first, then the full suite:

```bash
npx vitest run path/to/file.test.ts
npm test
npm run test:integration   # when a boundary changed
```

## Never

- Delete, skip, or weaken a test to make an implementation pass. If a test is
  genuinely wrong, fix it deliberately and say so.
- Commit `.only` or an unexplained `.skip`.
- Assert on a snapshot nobody reads.

## Report

List the tests added and what each covers, the commands run and their actual
output, whether the integration suite ran or skipped, and any coverage gap you
deliberately left with the reason.
