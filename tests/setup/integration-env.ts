import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { config as loadDotenv } from 'dotenv'

/**
 * Environment for the integration project, applied before any module loads.
 *
 * Two jobs, in this order:
 *
 *  1. **Point the application at the throwaway database.** `@/lib/db` builds
 *     its pool from `DATABASE_URL` at import time. Integration tests write and
 *     delete rows, so `DATABASE_URL` is overwritten with `TEST_DATABASE_URL`
 *     here — a real database configured for the app is never touched.
 *  2. **Satisfy the server env schema.** `parseServerEnv` refuses to start
 *     without NextAuth, Redis, and cron secrets. None of them are exercised by
 *     these tests, so obvious throwaway values are supplied, and only when the
 *     variable is not already set.
 *
 * `.env.local` is **deliberately not read**. That file configures the running
 * application and normally points at the real database; sourcing a
 * `TEST_DATABASE_URL` from it is how a test run ends up deleting production
 * rows. Test configuration comes from the shell, from `.env.test.local`, or
 * from `.env.test` — nowhere else.
 */

const projectRoot = process.cwd()

// Loaded most-specific first; `dotenv` never overwrites a variable that is
// already set, so an explicit shell value always wins.
for (const file of ['.env.test.local', '.env.test']) {
  const path = resolve(projectRoot, file)
  if (existsSync(path)) loadDotenv({ path })
}

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim()

/**
 * Say so when `.env.local` defines a `TEST_DATABASE_URL` that was ignored.
 *
 * Without this the run looks identical to "no database configured": every suite
 * skips and the command passes, and nobody learns that the variable they set
 * was never read.
 */
function warnAboutIgnoredLocalEnv(): void {
  const path = resolve(projectRoot, '.env.local')
  if (!existsSync(path)) return

  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    return
  }
  if (!/^\s*TEST_DATABASE_URL\s*=/m.test(contents)) return

  notify(
    '.env.local defines TEST_DATABASE_URL, and it was ignored on purpose. ' +
    'That file points at the running application\'s database, and these tests ' +
    'delete rows. Put the test connection string in .env.test.local instead, ' +
    'or pass it on the command line.',
  )
}

/**
 * Written straight to stderr rather than through `console`.
 *
 * Vitest intercepts console output from a setup file and does not surface it,
 * which would make a skipped run indistinguishable from a passing one — the
 * exact confusion this message exists to prevent.
 */
function notify(message: string): void {
  process.stderr.write(`[integration] ${message}\n`)
}

/**
 * Refuse a database that is not obviously a scratch one.
 *
 * These tests delete rows. A connection string that points at a real database
 * would be destructive and silent, so the name has to say `test` out loud. This
 * throws rather than skipping: whoever set the variable meant to run against
 * it, and quietly doing nothing would hide the mistake.
 */
function assertDisposableDatabase(url: string): void {
  let databaseName: string
  try {
    databaseName = new URL(url).pathname.replace(/^\//, '')
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid connection URL')
  }

  if (!/test/i.test(databaseName)) {
    throw new Error(
      `Refusing to run integration tests against database "${databaseName}". ` +
      'These tests insert and delete rows, so TEST_DATABASE_URL must name a ' +
      'disposable database with "test" in its name (e.g. oneflowe_test). ' +
      'Never point it at the database the application runs on.',
    )
  }
}

if (TEST_DATABASE_URL) {
  assertDisposableDatabase(TEST_DATABASE_URL)
  process.env.DATABASE_URL = TEST_DATABASE_URL
  notify(`running against ${new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '')}`)
} else {
  // Said out loud every time: a skipped run and a passing run otherwise look
  // identical, and "0 failures" must never be mistaken for "the tests ran".
  notify('TEST_DATABASE_URL is not set — every integration test will SKIP.')
  warnAboutIgnoredLocalEnv()
  // The placeholder only has to be well formed enough for the pool to be
  // constructed at import; it is never connected to.
  process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:5432/unused_test'
}

const testDefaults: Record<string, string> = {
  NODE_ENV: 'test',
  NEXTAUTH_URL: 'http://localhost:3000',
  NEXTAUTH_SECRET: 'integration-tests-nextauth-secret-value',
  UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:8079',
  UPSTASH_REDIS_REST_TOKEN: 'integration-tests-upstash-token-value',
  CRON_SECRET: 'integration-tests-cron-secret-value',
}

for (const [key, value] of Object.entries(testDefaults)) {
  if (!process.env[key]) process.env[key] = value
}
