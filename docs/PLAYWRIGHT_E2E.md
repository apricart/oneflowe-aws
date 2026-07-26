# Playwright E2E tests

The Playwright suite runs the Next.js application locally and uses only
`TEST_DATABASE_URL`. It refuses to run if that variable is missing or resolves
to the same database identity as `DATABASE_URL`, unless the developer
explicitly confirms that the shared target is test-only.

## One-time setup

Add the isolated PostgreSQL connection to `.env.local`:

```dotenv
TEST_DATABASE_URL=postgresql://user:password@host:5432/oneflowe_e2e
```

Install the Chromium browser from PowerShell:

```powershell
npm run e2e:install
```

## Run

```powershell
npm run e2e
```

If both variables intentionally identify the same test-only database, opt in
for the current PowerShell session:

```powershell
$env:E2E_ALLOW_DATABASE_URL_MATCH = "1"
npm run e2e
```

Other useful modes:

```powershell
npm run e2e:headed
npm run e2e:ui
npm run e2e:debug
npm run e2e:report
```

The run automatically:

1. Applies the checked-in Drizzle migrations to `TEST_DATABASE_URL`.
2. Seeds deterministic `e2e.*` users, two isolated tenants, inventory, and a
   current-month budget.
3. Starts Next.js on `http://localhost:3100` with `DATABASE_URL` overridden to
   the test database.
4. Runs Chromium tests with one worker for deterministic financial assertions.

The fixture password is `OneFloweE2E!2026`. It is test-only and must never be
used for a real account.

Failed runs retain screenshots, videos, and traces in `test-results`. The HTML
report is generated in `playwright-report`.
