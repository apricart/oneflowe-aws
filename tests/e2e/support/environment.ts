import { loadEnvConfig } from "@next/env"

function connectionIdentity(value: string) {
  const url = new URL(value)
  return [
    url.protocol,
    url.hostname.toLowerCase(),
    url.port || "5432",
    decodeURIComponent(url.username || ""),
    url.pathname.replace(/\/+$/, ""),
  ].join("|")
}

export function loadE2EEnvironment() {
  loadEnvConfig(process.cwd())

  const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim()
  if (!testDatabaseUrl) {
    throw new Error(
      "TEST_DATABASE_URL is missing. Add TEST_DATABASE_URL=postgresql://... to .env.local. " +
      "The E2E suite will never fall back to DATABASE_URL.",
    )
  }

  const parsed = new URL(testDatabaseUrl)
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.pathname.length <= 1) {
    throw new Error(
      "TEST_DATABASE_URL must be a PostgreSQL URL containing a database name.",
    )
  }

  const runtimeDatabaseUrl = process.env.DATABASE_URL?.trim()
  if (
    runtimeDatabaseUrl &&
    connectionIdentity(runtimeDatabaseUrl) === connectionIdentity(testDatabaseUrl) &&
    process.env.E2E_ALLOW_DATABASE_URL_MATCH !== "1"
  ) {
    throw new Error(
      "Safety check failed: TEST_DATABASE_URL points to the same database identity as DATABASE_URL. " +
      "If this is intentionally a test-only database, set E2E_ALLOW_DATABASE_URL_MATCH=1 for that run.",
    )
  }

  return {
    baseUrl: process.env.E2E_BASE_URL || "http://localhost:3100",
    testDatabaseUrl,
  }
}
