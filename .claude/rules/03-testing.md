# 03 — Testing

Every business-logic change requires automated tests. A test is not optional
because the change is small.

## The two projects

| | Unit & contract | Integration |
|---|---|---|
| Command | `npm test` | `npm run test:integration` |
| Location | beside the code, `lib/**/*.test.ts` | `tests/integration/**` |
| Needs | nothing | a disposable Postgres whose name contains `test` |

`tests/README.md` is the authority on setup. Two points that matter:

- Integration tests **skip silently and pass** without `TEST_DATABASE_URL`. A
  green `npm run test:integration` does not mean the integration tests ran.
  Check the stderr notice before claiming integration coverage.
- `.env.local` is deliberately not read for `TEST_DATABASE_URL`. Never
  "fix" a skipping suite by pointing it at the application database.

## What to cover

For any change, cover the applicable ones:

- happy path
- validation failure / malformed input
- boundary conditions (zero, empty, maximum, off-by-one)
- thrown exceptions and error paths
- **authorization**: each role that should be allowed, each that should not
- **tenant isolation**: a caller from organization A cannot read or write
  organization B's rows
- database behaviour: constraints, cascades, transaction rollback
- external dependency failure (S3, SES, Redis, the legacy K-Electric platform)
- duplicate submission / retry / idempotency

## Test kinds in this repo

- **Behavioural** — import the module and call it. Prefer these.
- **Contract** — read a file's source and assert on it, as
  `lib/server/security-boundaries.test.ts` and `lib/pricing-access.test.ts` do.
  Use where the guarantee is structural ("every route that writes a price goes
  through `lib/pricing-access.ts`"). When you add a route in one of those
  categories, **add it to the contract test's route list** — that list is the
  control, and a route missing from it is silently unprotected.
- **E2E** — Playwright, for critical journeys only (login, place order, approve
  order). See `docs/PLAYWRIGHT_E2E.md`.

## Prohibited

- Deleting, skipping, or weakening a test to make an implementation pass. If a
  test is wrong, fix the test deliberately and say so in the PR.
- Asserting on the implementation instead of the behaviour.
- Tests that depend on execution order, wall-clock time, or a shared mutable
  fixture.
- Committing a `.only` or a `.skip` without an accompanying reason.
