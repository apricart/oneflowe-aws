/**
 * Apply pending migrations, and say so when it cannot.
 *
 * This replaces `drizzle-kit migrate`, which reports a failure as an exit
 * code and nothing else: its progress view renders the "rejected" state with
 * the same spinner frame as "pending" and throws away the error it is handed,
 * and `renderWithTask` then calls `process.exit(1)` instead of rethrowing, so
 * drizzle-kit's own `console.error` never runs. On 2026-09-26 that made a
 * migration blocked by a check constraint look exactly like one that had
 * applied, and production sat three migrations behind while the deployed code
 * needed all three.
 *
 * It drives drizzle-orm's migrator, which is what `drizzle-kit migrate` calls
 * underneath — same journal table, same folder, same ordering, same hashes —
 * so the two remain interchangeable.
 *
 * One command per environment (`lib/migration-target.ts`):
 *
 *   npm run db:migrate:dev     --env=development
 *   npm run db:migrate:test    --env=test
 *   npm run db:migrate:prod    --env=production, a dry run that prints a
 *                              digest; `-- --confirm=<digest>` applies
 *
 * Each reads only its own env file and refuses a connection string that does
 * not look like its environment. Plain `db:migrate` names no environment and
 * applies nothing.
 *
 * Reads the migration identity only, never DATABASE_URL: the runtime identity
 * must not hold schema-admin rights (rule 06).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Client } from "pg"

import { readMigrationEnvFor } from "../lib/server/migration-env"
import {
  describeMigrationFailure,
  pendingMigrations,
  type JournalEntry,
} from "../lib/migration-report"
import {
  MIGRATE_USAGE,
  MigrationTargetRefusal,
  assertTargetMatchesEnvironment,
  describeMigrationTarget,
  migrationSslFor,
  parseMigrationArgs,
  productionPlanDigest,
  selectMigrationUrl,
} from "../lib/migration-target"

const MIGRATIONS_FOLDER = join(process.cwd(), "drizzle")

function readJournal(): JournalEntry[] {
  const raw = readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")
  return (JSON.parse(raw) as { entries?: JournalEntry[] }).entries ?? []
}

async function lastAppliedWhen(client: Client): Promise<number | null> {
  // The table may not exist yet on a database that has never been migrated;
  // drizzle creates it, and until then there is nothing applied.
  const { rows } = await client.query<{ created_at: string | null }>(
    `SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`
  ).catch(() => ({ rows: [] as { created_at: string | null }[] }))
  const newest = rows[0]?.created_at
  return newest === null || newest === undefined ? null : Number(newest)
}

async function main(): Promise<void> {
  const { environment, confirm } = parseMigrationArgs(process.argv.slice(2))
  if (environment === null) {
    console.error(MIGRATE_USAGE)
    process.exitCode = 1
    return
  }

  const { env, filesRead } = readMigrationEnvFor(environment)
  const { url, variable } = selectMigrationUrl(environment, env)
  assertTargetMatchesEnvironment(environment, url)

  const source = process.env[variable] ? "shell" : (filesRead.join(", ") || "shell")
  console.log(`[migrate] environment: ${environment.toUpperCase()}`)
  console.log(`[migrate] target:  ${describeMigrationTarget(url)}  (${variable} from ${source})`)

  const client = new Client({
    connectionString: url,
    ssl: migrationSslFor(environment, url),
    connectionTimeoutMillis: 30_000,
    statement_timeout: 300_000,
  })
  await client.connect()

  try {
    const journal = readJournal()
    const before = await lastAppliedWhen(client)
    const pending = pendingMigrations(journal, before)

    console.log(`[migrate] journal: ${journal.length} in drizzle/, newest applied ${before ?? "none"}`)

    if (pending.length === 0) {
      console.log("[migrate] nothing to apply.")
      return
    }

    console.log(`[migrate] ${pending.length} pending:`)
    for (const entry of pending) console.log(`             ${entry.tag}`)

    if (environment === "production") {
      const digest = productionPlanDigest(url, pending.map((entry) => entry.tag))
      if (confirm === null) {
        console.log("")
        console.log("[migrate] DRY RUN — nothing applied. To apply exactly these to this database:")
        console.log(`             npm run db:migrate:prod -- --confirm=${digest}`)
        return
      }
      if (confirm !== digest) {
        console.error(
          "[migrate] REFUSED: --confirm does not match this plan. The target or the pending " +
            `migrations changed since the dry run; this plan's digest is ${digest}.`,
        )
        process.exitCode = 1
        return
      }
    } else if (confirm !== null) {
      console.error(`[migrate] REFUSED: --confirm is for production only, not ${environment}.`)
      process.exitCode = 1
      return
    }

    console.log(`[migrate] applying ${pending.length}...`)
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER })

    // Confirm from the database rather than from the absence of a throw.
    const after = await lastAppliedWhen(client)
    const stillPending = pendingMigrations(journal, after)
    if (stillPending.length > 0) {
      console.error(
        `[migrate] FAILED: ${stillPending.length} still pending after the run ` +
          `(${stillPending.map((entry) => entry.tag).join(", ")}).`
      )
      process.exitCode = 1
      return
    }

    console.log(`[migrate] applied ${pending.length}. Journal is up to date.`)
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch((error: unknown) => {
  if (error instanceof MigrationTargetRefusal) {
    console.error(`[migrate] REFUSED: ${error.message}`)
    process.exitCode = 1
    return
  }
  console.error("")
  console.error(describeMigrationFailure(error))
  process.exitCode = 1
})
