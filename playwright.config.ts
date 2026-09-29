import { defineConfig, devices } from "@playwright/test"
import { config as loadDotenv } from "dotenv"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { E2E_BASE_URL, E2E_PORT, serverEnv } from "./tests/e2e/support/environment"

/**
 * End-to-end coverage for the role deployment smoke suite and the admin
 * activity-log journey. Anything that can be proved without a browser remains
 * in `npm test` or `npm run test:integration`.
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
  // A cold Next.js compiler can replace the first navigation while it builds a
  // role workspace. Leave enough time for the web-first landing assertion.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // CI already runs a production build as its own gate. The browser suite uses
    // an isolated Webpack dev server so failures identify the journey rather
    // than spend another build's worth of time. Webpack also avoids Turbopack
    // treating unrelated tool workspaces as CSS source globs on Windows.
    command: `npx next dev --webpack --hostname 127.0.0.1 --port ${E2E_PORT}`,
    url: E2E_BASE_URL,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    env: serverEnv(testDatabaseUrl),
  },
})
