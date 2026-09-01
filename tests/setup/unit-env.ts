/**
 * Environment for the unit project.
 *
 * Importing anything under `lib/server/` pulls in `@/lib/db`, which validates
 * the server environment at import time and refuses to load without NextAuth,
 * Redis, and cron values. Supplying throwaway ones here is what lets a unit test
 * import and call server code instead of asserting on its source text.
 *
 * `DATABASE_URL` is **forced**, not defaulted. A unit test must never reach a
 * database — not a developer's, and not the one a shell variable happens to
 * point at — so the value is overwritten unconditionally with an address
 * nothing listens on. A test that tries to query fails to connect, which is the
 * correct and loud outcome; anything needing real rows belongs in
 * `tests/integration/`, which has its own setup and its own guards.
 *
 * `.env.local` is deliberately never read here, for the same reason.
 */

process.env.DATABASE_URL = 'postgres://unit:unit@127.0.0.1:1/unit_tests_never_connect'

const testDefaults: Record<string, string> = {
  NODE_ENV: 'test',
  NEXTAUTH_URL: 'http://localhost:3000',
  // The schema requires at least 32 characters for every secret.
  NEXTAUTH_SECRET: 'unit-tests-nextauth-secret-placeholder-value',
  UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:8079',
  UPSTASH_REDIS_REST_TOKEN: 'unit-tests-upstash-token-placeholder-value',
  CRON_SECRET: 'unit-tests-cron-secret-placeholder-value',
}

for (const [key, value] of Object.entries(testDefaults)) {
  if (!process.env[key]) process.env[key] = value
}
