# Playwright E2E tests

The Playwright suite runs the Next.js application locally against
`TEST_DATABASE_URL`. It refuses to run if that variable is missing, if it does
not name a database with `test` in it, or if it resolves to the same database
identity as `DATABASE_URL` — unless the developer explicitly confirms that the
shared target is test-only.

## Scope

Browser coverage is held to **one journey per user-facing feature**: the
critical path a person takes through the screens, plus the access boundary
(who is not offered it, and that the endpoint refuses them too). Arithmetic,
SQL behaviour and edge cases stay in `npm test` and `npm run test:integration`,
which every spec's header names.

| Spec | Feature (plan under `plans/`) |
|---|---|
| `role-smoke.spec.ts` | Deployment gate: every role signs in to its workspace; an order is created, approved and fulfilled only by the right roles |
| `role-switch.spec.ts` | `OF-ROLE-branch-admin-order-portal-switch` |
| `activity-log.spec.ts` | `OF-AUDIT-admin-activity-log` |
| `organization-budget-toggle.spec.ts` | `OF-BUDGET-organization-budget-toggle` |
| `organization-join-domain.spec.ts` | `OF-JOIN-email-domain-lock` |
| `organization-join.spec.ts` | `OF-JOIN-organization-self-service-join` (code → request → approval → sign-in) |
| `order-auto-approval.spec.ts` | `OF-ORDERS-organization-auto-approval` |
| `ordering-gates.spec.ts` | `OF-ORDERS-pending-invoice-notice`, `OF-PAYMENT-CONTROL-unpaid-invoice-ordering-block`, `OF-ORDERS-unacknowledged-delivery-ordering-block` |
| `delivery-addresses.spec.ts` | `OF-ADDR-multiple-delivery-addresses` |
| `product-requests.spec.ts` | `OF-PRODUCT-REQUEST-head-office-new-product-requests` |
| `support-threads.spec.ts` | `OF-SUPPORT-portal-to-apricart-threads`, `-order-search`, `-product-reference`, `-shell-and-kpis` |
| `password-recovery.spec.ts` | `OF-AUTH-self-service-password-reset`, `OF-KE-password-change-without-email-verification` |
| `viewer-role.spec.ts` | `OF-VIEWER-readonly-dashboard-role` |
| `budget-allocation.spec.ts` | `OF-BUDGET-addon-validity`, `OF-GROUP-USER-budget-allocation`, `-per-user` |
| `group-orders.spec.ts` | `OF-GROUP-ORDER-CROSS-ROLE-VISIBILITY`, `OF-GROUP-branch-owns-order-writes`, `OF-GROUP-PORTAL-other-orders-tab`, `OF-GROUP-USER-other-orders-tab` |
| `executive-analytics.spec.ts` | `OF-EXEC-ANALYTICS-*`, `OF-REPORTS-*`, `OF-GROUP-USER-graphical-reports`, `OF-BUDGET-BURN-*`, `OF-PRODUCT-monthly-consumption-trend` |

Plans with no screen of their own are deliberately not here: the K-Electric
sync and repair scripts (`KE-*`, `OF-KE-*` other than the password change), the
ledger/orders parity rule, the custom-roles investigation (not built), and the
coverage plans themselves.

### Each feature spec owns a tenant

`tests/e2e/support/tenant.ts` seeds an organization of the spec's own, keyed by
a short feature key (`E2E <key> Org`, users `e2e-<key>-…`, products
`E2E-<KEY>-…`), with a Super Admin of its own. Nothing a journey switches on or
orders can reach another spec or the shared role-smoke tenant. Its teardown
reads the database's foreign keys and removes every row reachable from that
tenant, its users and its products, so a new table never needs adding to a
cleanup list. Pick a key no other spec uses, and never one that matches the
start of another organization's name (`Role`, `Budget`, `Activity`).

Two things a seed cannot do for you:

- **The company list is cached server-side for a minute.** A Super Admin who
  must find a freshly seeded company in `/organizations` goes through
  `openEditCompany` in `support/admin-ui.ts`, which clears that cache the way
  any company edit does.
- **There is no email service.** Password-reset delivery fails closed and the
  server retires the challenge; `password-recovery.spec.ts` stands in for the
  inbox by planting a known code with the server's own HMAC. Nothing else
  depends on email arriving.

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

## Three things worth knowing

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

**The dev server does not restart on memory pressure.** `next dev` normally
exits and restarts once its heap passes 80% of the limit (half the machine's
RAM by default). One server compiling most of the app crosses that on a CI
runner, and the restart drops the request in flight and recompiles every route
cold — a readiness check fails closed, the next test runs out of time, and
neither failure is about the code it names. The suite sets
`E2E_DISABLE_DEV_MEMORY_RESTART=1`, which `next.config.mjs` turns into
`experimental.devMemoryThresholdRestart: false`. If you see
"Server is approaching the used memory threshold, restarting..." in a run, that
flag is not reaching the server.

**The dev server keeps every route it compiles.** By default `next dev`
disposes a compiled route after 60 seconds unused and keeps at most five. The
suite revisits pages minutes apart, so each revisit compiled the page again,
along with every API route it prefetches. On a 2-vCPU runner that queue
outlasted the browser fetcher's 30-second timeout on every SWR retry. `/users`
then sat on "Unable to load users", and a role-switch test timed out waiting
for the search box. The suite sets `E2E_KEEP_COMPILED_ROUTES=1`, which
`next.config.mjs` turns into a long `onDemandEntries` lifetime. If one run log
shows "Compiling /some-route" twice, that flag is not reaching the server.

`next start` is not used: it forces production mode, where the server env
validator requires HTTPS for `NEXTAUTH_URL` and for the Redis URL.
