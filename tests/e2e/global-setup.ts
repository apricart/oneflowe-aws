import { config as loadDotenv } from "dotenv"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { resolveTestDatabaseUrl } from "./support/environment"
import { seedRoleSmokeE2E } from "./support/role-smoke-seed"
import { seedActivityLogE2E } from "./support/seed"

/**
 * Runs once, before the browser or the Next.js server starts.
 *
 * Loads the test connection the same way the integration project does — from
 * `.env.test.local` or `.env.test`, never from `.env.local`, which configures
 * the running application — then refuses anything that is not obviously a
 * scratch database and seeds the fixtures.
 *
 * The seed modules deliberately do not import `@/lib/db`: each builds a short-
 * lived pool from the validated URL passed to it. That makes every helper safe
 * to import statically, which is required because Playwright's CommonJS loader
 * cannot natively import these TypeScript modules at runtime in CI.
 */
export default async function globalSetup(): Promise<void> {
  const projectRoot = process.cwd()
  for (const file of [".env.test.local", ".env.test"]) {
    const path = resolve(projectRoot, file)
    // dotenv never overwrites a variable already set, so a shell value wins.
    if (existsSync(path)) loadDotenv({ path })
  }

  const testDatabaseUrl = resolveTestDatabaseUrl()

  process.env.DATABASE_URL = testDatabaseUrl
  process.env.TEST_DATABASE_URL = testDatabaseUrl

  // The seed builds its own pool from this connection and closes it, so nothing
  // here holds a handle open while the browser runs.
  const smokeOnly = process.env.npm_lifecycle_event === "e2e:smoke"
  if (!smokeOnly) {
    await seedActivityLogE2E(testDatabaseUrl)
  }

  await seedRoleSmokeE2E(testDatabaseUrl)

  process.stderr.write(
    `[e2e] seeded ${smokeOnly ? "role smoke" : "activity and role smoke"} fixtures in ${new URL(testDatabaseUrl).pathname.replace(/^\//, "")}\n`,
  )
}
