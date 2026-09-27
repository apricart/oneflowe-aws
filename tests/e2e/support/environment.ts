/**
 * The one rule this harness enforces before anything else runs: it never
 * touches the database the application runs on.
 *
 * The suite signs in, reads a cross-tenant audit trail and writes fixture rows.
 * Pointing it at a real database would be destructive and silent, so the
 * connection has to say `test` out loud and must not be the same identity as
 * `DATABASE_URL` unless the developer says so for the session.
 */

export const E2E_PORT = 3101
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`

/**
 * A build directory of this suite's own.
 *
 * Next keeps its dev-server lock at `<distDir>/dev/lock` and refuses to start a
 * second server against the same one, so without this the suite could only run
 * with `npm run dev` stopped. `next.config.mjs` reads `NEXT_DIST_DIR`; it is
 * unset everywhere else.
 */
export const E2E_DIST_DIR = ".next-e2e"

/** Test-only. Never a real account's password. */
export const E2E_PASSWORD = "OneFloweE2E!2026"

function databaseIdentity(url: string): string {
  const parsed = new URL(url)
  return `${parsed.host}${parsed.pathname}`
}

export function resolveTestDatabaseUrl(): string {
  const testUrl = process.env.TEST_DATABASE_URL?.trim()
  if (!testUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. The Playwright suite writes rows and signs in, so it " +
        "needs a migrated, disposable database whose name contains \"test\". Put it in " +
        ".env.test.local or pass it on the command line.",
    )
  }

  let name: string
  try {
    name = new URL(testUrl).pathname.replace(/^\//, "")
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid connection URL")
  }

  if (!/test/i.test(name)) {
    throw new Error(
      `Refusing to run end-to-end tests against database "${name}". These tests insert and ` +
        "delete rows, so TEST_DATABASE_URL must name a disposable database with \"test\" in its name.",
    )
  }

  const appUrl = process.env.DATABASE_URL?.trim()
  if (
    appUrl
    && process.env.E2E_ALLOW_DATABASE_URL_MATCH !== "1"
    && databaseIdentity(appUrl) === databaseIdentity(testUrl)
  ) {
    throw new Error(
      "TEST_DATABASE_URL and DATABASE_URL name the same database. If that target really is " +
        "test-only, opt in for this session with E2E_ALLOW_DATABASE_URL_MATCH=1.",
    )
  }

  return testUrl
}

/**
 * Environment for the Next.js server the suite drives.
 *
 * `DATABASE_URL` is overwritten with the test connection, and the server-env
 * schema's required values are filled with obvious throwaways. Nothing here is
 * a secret, and none of it reaches a real environment.
 */
export function serverEnv(testDatabaseUrl: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    NODE_ENV: "development",
    NEXT_DIST_DIR: E2E_DIST_DIR,
    // Keep browser tests self-contained. Cache/rate-limit fallbacks stay in
    // process and no test run depends on an external Redis service.
    ONEFLOWE_OFFLINE_MODE: "true",
    // Authoritative: `@next/env` never overwrites a variable already present in
    // the process environment, so `.env.local` — which on a developer machine
    // may well point at a real database — cannot replace this.
    DATABASE_URL: testDatabaseUrl,
    MIGRATION_DATABASE_URL: testDatabaseUrl,
    NEXTAUTH_URL: E2E_BASE_URL,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET ?? "e2e-tests-nextauth-secret-value-not-a-secret",
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL ?? "http://127.0.0.1:8079",
    // The server-env schema requires at least 32 characters for both. These are
    // obvious throwaways for a local run, not credentials.
    UPSTASH_REDIS_REST_TOKEN:
      process.env.UPSTASH_REDIS_REST_TOKEN ?? "e2e-tests-upstash-token-not-a-real-credential",
    CRON_SECRET: process.env.CRON_SECRET ?? "e2e-tests-cron-secret-not-a-real-credential",
  }
}
