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
 * Reads MIGRATION_DATABASE_URL only. Never DATABASE_URL: the runtime identity
 * must not hold schema-admin rights (rule 06).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Client } from "pg"

import { loadMigrationEnv } from "../lib/server/migration-env"
import {
  describeMigrationFailure,
  pendingMigrations,
  type JournalEntry,
} from "../lib/migration-report"

const MIGRATIONS_FOLDER = join(process.cwd(), "drizzle")

function readJournal(): JournalEntry[] {
  const raw = readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")
  return (JSON.parse(raw) as { entries?: JournalEntry[] }).entries ?? []
}

/** Where we are pointed, with the password left out. */
function describeTarget(url: string): string {
  const parsed = new URL(url)
  return `${parsed.host}${parsed.pathname} as ${parsed.username}`
}

/**
 * The same SSL posture the application uses (`lib/db-core.ts`): the Supabase
 * pooler presents a certificate Node does not trust, everything else must be
 * trusted in production, and a local database needs none.
 */
function sslFor(url: string) {
  const parsed = new URL(url)
  if (parsed.hostname.includes("supabase")) return { rejectUnauthorized: false }
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return false
  return process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : false
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
  const { MIGRATION_DATABASE_URL: url } = loadMigrationEnv()

  console.log(`[migrate] target:  ${describeTarget(url)}`)

  const client = new Client({
    connectionString: url,
    ssl: sslFor(url),
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

    console.log(`[migrate] applying ${pending.length}:`)
    for (const entry of pending) console.log(`             ${entry.tag}`)

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
  console.error("")
  console.error(describeMigrationFailure(error))
  process.exitCode = 1
})
