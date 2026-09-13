# Testing

Two Vitest projects, split by what they need to run.

| | Unit & contract | Integration |
|---|---|---|
| Command | `npm test` (or `npm run test:unit`) | `npm run test:integration` |
| Config | `vitest.config.ts` | `vitest.integration.config.ts` |
| Location | beside the code (`lib/**/*.test.ts`) | `tests/integration/**` |
| Environment | jsdom | node |
| Needs | nothing | a disposable Postgres |

`npm run test:all` runs both. `npm run test:watch` watches the unit project.

## Unit and contract tests

Live next to the code they cover. Two kinds:

- **Behavioural** — import the module and call it (`lib/price-ladder.test.ts`,
  `lib/group-price-input.test.ts`). Prefer these.
- **Contract** — read a file's source and assert on it
  (`lib/server/security-boundaries.test.ts`). Used where the guarantee is
  structural — "this route checks the tenant before reading a row" — or where
  running the code would need a database.

Anything requiring Postgres, Redis, or the network belongs in the integration
project, so `npm test` stays runnable with nothing installed.

### Importing server modules

`import "server-only"` throws outside a React Server Component, which used to
make anything under `lib/server/` untestable. Both configs alias the package to
an empty module (`tests/support/server-only-stub.ts`), so tests can import and
call server code directly. The real package still guards the application build.

## Integration tests

Real code against real Postgres — SQL semantics, constraints, cascades, and
route handlers with only the session faked.

**Without `TEST_DATABASE_URL` every suite skips itself and the command passes**,
so a fresh clone stays green. The run says so on stderr every time, because a
skipped run and a passing run otherwise look identical.

CI does not get that allowance. Both `dev-check.yml` (every PR to `dev`) and
`deploy-prod.yml` (every push to `main`, before the image is built) start a
throwaway Postgres 16 service container, migrate it, run this project against
it, and **fail the job if the runner reports a skip** instead of
`running against oneflowe_test`. A production deploy therefore cannot pass
with the integration suite silently switched off.

### Where the connection string comes from

The shell, `.env.test.local`, or `.env.test` — in that order, first value wins.

`.env.local` is **deliberately not read**. It configures the running
application and normally points at the real database; sourcing a
`TEST_DATABASE_URL` from it is how a test run ends up deleting production rows.
If `.env.local` defines one, the run prints a warning saying it was ignored.

Two guards back this up:

- The database name **must contain `test`**. Anything else throws rather than
  skipping — whoever set the variable meant to run against it, and quietly
  doing nothing would hide the mistake.
- `DATABASE_URL` is overwritten with `TEST_DATABASE_URL` before any module
  loads, so `@/lib/db` cannot pick up the application's own database.

### Running them

1. Get a disposable Postgres database whose name contains `test`. Any of these
   works — Docker is only the quickest option on a machine with no Postgres
   installed:

   - **Docker**

     ```bash
     docker run --name oneflowe-test-db -e POSTGRES_PASSWORD=postgres \
       -p 5433:5432 -d postgres:16
     docker exec oneflowe-test-db createdb -U postgres oneflowe_test
     ```

   - **An existing Postgres server** — `CREATE DATABASE oneflowe_test;`
   - **A second cloud project** (Supabase, Neon, …). Note that a Supabase
     project gives you one database named `postgres`, so a *separate project*
     is needed — the production one is refused by name.

2. Migrate it. Drizzle reads `MIGRATION_DATABASE_URL`, never `DATABASE_URL`:

   ```bash
   MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5433/oneflowe_test \
     npm run db:migrate
   ```

3. Run the suite:

   ```bash
   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/oneflowe_test \
     npm run test:integration
   ```

`tests/setup/integration-env.ts` copies `TEST_DATABASE_URL` over `DATABASE_URL`
before any module loads, so a real database in `.env.local` is never touched,
and fills in throwaway NextAuth/Redis/cron values the server env schema demands.

### What is covered

| Suite | Exercises |
|---|---|
| `group-price-ladder`, `group-pricing-api`, `organization-price-propagation` | The price ladder and its endpoints |
| `executive-analytics-api` | The Compare Side by Side tab's four routes (`compare`, `options`, `drill-down`, `overview`): 401/403 per role, the user row overriding the session claim, tenant isolation, every panel's figures against a hand-computed order history, refund netting, whole-order vs line-by-line money, the unit-of-measure rule, the pickers, and drill-down reconciliation. `helpers/executive-analytics-fixtures.ts` documents the history and the expected answers. |

### Writing them

- Build rows through a fixture helper (`tests/integration/helpers/`), give every
  fixture a unique suffix, and delete what you made in `afterAll`. Files run one
  at a time (`fileParallelism: false`) because they share one database.
- Gate the suite on the database: `describe.skipIf(!hasTestDatabase)(...)`.
- Fake only identity. `tests/integration/group-pricing-api.test.ts` mocks
  `getServerSession` and Redis, then lets the role checks, tenant checks,
  writes, and audit rows run for real — those are the parts worth testing.
- Call `closePool()` in `afterAll` so the run exits cleanly.

## End-to-end

`@playwright/test` and the `npm run e2e:*` scripts exist, but there is no
`playwright.config.ts` and no `tests/e2e/` yet, so those scripts do not run
anything. Both Vitest projects already exclude `tests/e2e/**`, so adding a
Playwright config later will not collide with them.
