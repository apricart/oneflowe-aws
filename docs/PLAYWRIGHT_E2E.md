# Playwright E2E tests

The Playwright suite runs the Next.js application locally against
`TEST_DATABASE_URL`. It refuses to run if that variable is missing, if it does
not name a database with `test` in it, or if it resolves to the same database
identity as `DATABASE_URL` — unless the developer explicitly confirms that the
shared target is test-only.

## Scope

Two suites run in the browser:

- `tests/e2e/role-smoke.spec.ts` is the deployment gate. It signs in as Super
  Admin, Head Office, Branch Admin, Order Portal, Group Order Portal, Group
  User, and Employee; probes each persona's primary data path; verifies the
  group roles' assigned scope; and completes an order from creation through
  approval and Super Admin fulfillment. It also proves the requester cannot
  approve and the approver cannot fulfill.
- `tests/e2e/activity-log.spec.ts` covers the Super Admin activity log and its
  Head Office access boundary.

Keep browser coverage focused on critical journeys and rendered role routing.
Detailed arithmetic, SQL behavior, and edge cases belong in `npm test` or
`npm run test:integration`.

## One-time setup

Add the isolated PostgreSQL connection to `.env.test.local` — **not**
`.env.local`, which configures the running application and may point at a real
database:

```dotenv
TEST_DATABASE_URL=postgresql://user:password@host:5432/oneflowe_test
```

The database must already have the checked-in Drizzle migrations applied; the
suite seeds rows but does not migrate.

Install the Chromium browser from PowerShell:

```powershell
npm run e2e:install
```

## Run

```powershell
npm run e2e
```

Run only the deployment smoke gate:

```powershell
npm run e2e:smoke
```

Other modes:

```powershell
npm run e2e:headed
npm run e2e:ui
npm run e2e:debug
npm run e2e:report
```

If both variables intentionally identify the same test-only database, opt in for
the current PowerShell session:

```powershell
$env:E2E_ALLOW_DATABASE_URL_MATCH = "1"
npm run e2e
```

## What the run does

1. `tests/e2e/global-setup.ts` loads `.env.test.local` (then `.env.test`),
   validates the connection, and seeds deterministic activity fixtures plus
   idempotent role, assignment, catalog, inventory, and budget fixtures. The
   smoke-only command seeds only its non-destructive role fixtures.
2. Starts an isolated `next dev --webpack` server on `http://127.0.0.1:3101`,
   with `DATABASE_URL` pointed at the test database.
3. Runs Chromium with one worker and no retries.

The fixture password is `OneFloweE2E!2026`. It is test-only and must never be
used for a real account.

Failed runs keep screenshots, videos and traces under `test-results`; the HTML
report goes to `playwright-report`. Open a trace with:

```powershell
npx playwright show-trace test-results\<folder>\trace.zip
```

## Deployment gate

The production, staging, and `dev` pull-request workflows install Chromium and
run `npm run e2e:smoke` against their fresh migrated Postgres service. A smoke
failure stops the job before image build/deployment, and the Playwright report,
trace, screenshot, and video are uploaded as a workflow artifact.

## Two things worth knowing

**It runs beside `npm run dev`.** Next keeps its dev-server lock at
`<distDir>/dev/lock` and refuses to start a second server against the same one.
`next.config.mjs` therefore reads `distDir: process.env.NEXT_DIST_DIR || '.next'`
and the suite sets `NEXT_DIST_DIR=.next-e2e`, so you do not have to stop your dev
server. That directory is excluded from git, ESLint, Vitest and `tsc` — if you
add another tool that globs the project, exclude it there too, or it will read
several thousand generated files.

**`.env.local` cannot hijack the target.** The test connection is passed to the
server through `webServer.env`, and `@next/env` never overwrites a variable that
is already in the process environment. The seed builds its own pool from the
validated connection string rather than importing `@/lib/db`, so it cannot reach
whatever `DATABASE_URL` happened to resolve to.

`next start` is not used: it forces production mode, where the server env
validator requires HTTPS for `NEXTAUTH_URL` and for the Redis URL.
