import { defineConfig, devices } from "@playwright/test"
import { config as loadDotenv } from "dotenv"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { E2E_BASE_URL, E2E_PORT, serverEnv } from "./tests/e2e/support/environment"

/**
 * A minimal end-to-end harness, for the admin activity log.
 *
 * Deliberately narrow. The repository's former Playwright suite was removed in
 * the two "sonar" commits, and this is not a restoration of it — it covers the
 * one journey this change adds, in a real browser, and nothing else. Anything
 * that can be proved without a browser is proved in `npm test` or
 * `npm run test:integration`; a browser test is the slowest and most brittle
 * kind, so it earns its place only where rendering and navigation are the thing
 * under test.
 *
 * The run starts its own Next.js server with `DATABASE_URL` pointed at
 * `TEST_DATABASE_URL`, so the application under test can never reach the
 * database the real one uses. `tests/e2e/global-setup.ts` refuses to proceed if
 * that connection is missing, is not obviously disposable, or is the same
 * identity as `DATABASE_URL`.
 */

// The connection is needed here too, to build the server's environment.
for (const file of [".env.test.local", ".env.test"]) {
  const path = resolve(process.cwd(), file)
  if (existsSync(path)) loadDotenv({ path })
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim() ?? ""

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  // Financial and audit assertions must not race each other over one database.
  workers: 1,
  fullyParallel: false,
  // A flake here is a defect to diagnose, not to retry away.
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Dev rather than a production build: the suite is one journey, and a build
    // would dominate its run time. Turbopack's first compile is slow, hence the
    // generous timeout.
    command: `npx next dev --hostname 127.0.0.1 --port ${E2E_PORT}`,
    url: E2E_BASE_URL,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    env: serverEnv(testDatabaseUrl),
  },
})
