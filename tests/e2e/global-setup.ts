import { config as loadDotenv } from "dotenv"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Runs once, before the browser or the Next.js server starts.
 *
 * Loads the test connection the same way the integration project does — from
 * `.env.test.local` or `.env.test`, never from `.env.local`, which configures
 * the running application — then refuses anything that is not obviously a
 * scratch database and seeds the fixtures.
 *
 * `@/lib/db` builds its pool from `DATABASE_URL` at import time, so the
 * override has to happen before the seed module is imported. That is why the
 * import below is dynamic.
 */
export default async function globalSetup(): Promise<void> {
  const projectRoot = process.cwd()
  for (const file of [".env.test.local", ".env.test"]) {
    const path = resolve(projectRoot, file)
    // dotenv never overwrites a variable already set, so a shell value wins.
    if (existsSync(path)) loadDotenv({ path })
  }

  const { resolveTestDatabaseUrl } = await import("./support/environment")
  const testDatabaseUrl = resolveTestDatabaseUrl()

  process.env.DATABASE_URL = testDatabaseUrl
  process.env.TEST_DATABASE_URL = testDatabaseUrl

  // The seed builds its own pool from this connection and closes it, so nothing
  // here holds a handle open while the browser runs.
  const smokeOnly = process.env.npm_lifecycle_event === "e2e:smoke"
  if (!smokeOnly) {
    const { seedActivityLogE2E } = await import("./support/seed")
    await seedActivityLogE2E(testDatabaseUrl)
  }

  const { seedRoleSmokeE2E } = await import("./support/role-smoke-seed")
  await seedRoleSmokeE2E(testDatabaseUrl)

  process.stderr.write(
    `[e2e] seeded ${smokeOnly ? "role smoke" : "activity and role smoke"} fixtures in ${new URL(testDatabaseUrl).pathname.replace(/^\//, "")}\n`,
  )
}
