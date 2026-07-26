import { defineConfig, devices } from "@playwright/test"

import { loadE2EEnvironment } from "./tests/e2e/support/environment"

const environment = loadE2EEnvironment()

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  timeout: 120_000,
  expect: {
    timeout: 30_000,
  },
  globalSetup: "./tests/e2e/global-setup.ts",
  outputDir: "test-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: environment.baseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
  webServer: {
    command: "npm run dev:legacy -- --hostname localhost --port 3100",
    url: environment.baseUrl,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DATABASE_URL: environment.testDatabaseUrl,
      NEXTAUTH_URL: environment.baseUrl,
      NEXTAUTH_SECRET:
        process.env.NEXTAUTH_SECRET ||
        "oneflowe-e2e-nextauth-secret-2026-at-least-32-characters",
      CRON_SECRET:
        process.env.CRON_SECRET ||
        "oneflowe-e2e-cron-secret-2026-at-least-32-characters",
      UPSTASH_REDIS_REST_URL: "http://127.0.0.1:9",
      UPSTASH_REDIS_REST_TOKEN:
        "oneflowe-e2e-local-redis-token-not-used-2026",
      SESSION_VALIDATION_CACHE_TTL_SECONDS: "0",
      E2E_TESTING: "1",
    },
  },
})
