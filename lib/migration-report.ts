/**
 * Reporting for the migration runner — the pure part.
 *
 * `drizzle-kit migrate` reports a failure as an exit code and nothing else.
 * Its progress view renders the "rejected" state with the same spinner frame
 * as "pending" and discards the error it is handed, and `renderWithTask` then
 * calls `process.exit(1)` rather than rethrowing, so drizzle-kit's own
 * `console.error` never runs. A migration that cannot apply therefore looks
 * exactly like one that did. That cost a production outage on 2026-09-26.
 *
 * `scripts/migrate.ts` drives drizzle-orm's migrator directly instead, and
 * uses what is here to say what it is about to do and what went wrong.
 *
 * Nothing here reads a clock, a file or a database.
 */

/** One entry of `drizzle/meta/_journal.json`. */
export type JournalEntry = {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

/**
 * Which entries drizzle will apply next, given the newest `created_at`
 * already recorded in `drizzle.__drizzle_migrations`.
 *
 * This mirrors `PgDialect.migrate` exactly: an entry applies when its `when`
 * is strictly greater than that value, and every entry applies when the table
 * is empty. Ordered as drizzle applies them, oldest first.
 */
export function pendingMigrations(
  entries: readonly JournalEntry[],
  lastAppliedWhen: number | null,
): JournalEntry[] {
  return entries
    .filter((entry) => lastAppliedWhen === null || lastAppliedWhen < entry.when)
    .sort((a, b) => a.when - b.when || a.idx - b.idx)
}

/**
 * The fields a Postgres error carries that are worth printing. `pg` puts them
 * on the error object; drizzle wraps that object as `cause` under a message
 * naming the statement it was running.
 */
const PG_ERROR_FIELDS = [
  ["code", "pg code"],
  ["constraint", "constraint"],
  ["table", "table"],
  ["column", "column"],
  ["detail", "detail"],
  ["hint", "hint"],
  ["position", "position"],
  ["where", "where"],
] as const

function readString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim()
  if (typeof value === "number") return String(value)
  return null
}

/** The chain of `cause`s, innermost last, bounded so a cycle cannot hang. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current = error
  const seen = new Set<unknown>()
  while (current && typeof current === "object" && !seen.has(current) && chain.length < 8) {
    seen.add(current)
    chain.push(current)
    current = (current as { cause?: unknown }).cause
  }
  return chain
}

/**
 * The statement drizzle was running, pulled out of the message it wraps the
 * driver error in ("Failed query: <sql>\nparams: ..."). Returns null when the
 * message is not in that shape.
 */
export function failingStatementOf(error: unknown): string | null {
  for (const link of causeChain(error)) {
    const message = readString((link as { message?: unknown }).message)
    if (!message?.startsWith("Failed query:")) continue
    const body = message.slice("Failed query:".length)
    const statement = body.split(/\nparams:/)[0]
    const trimmed = statement.trim()
    if (trimmed.length > 0) return trimmed
  }
  return null
}

/** The most specific message in the chain — the driver's, not drizzle's wrapper. */
export function reasonOf(error: unknown): string {
  for (const link of [...causeChain(error)].reverse()) {
    const message = readString((link as { message?: unknown }).message)
    if (message && !message.startsWith("Failed query:")) return message
  }
  const first = readString((error as { message?: unknown })?.message)
  return first ?? String(error)
}

/**
 * A readable account of a failed migration, for a terminal.
 *
 * It always states that nothing was applied, because drizzle runs every
 * pending migration inside a single transaction — a failure anywhere rolls
 * the whole run back, and a reader who does not know that will go looking for
 * a half-migrated database.
 */
export function describeMigrationFailure(error: unknown): string {
  const lines: string[] = ["Migration FAILED.", ""]
  lines.push(`  reason:     ${reasonOf(error)}`)

  const seen = new Set<string>()
  for (const link of causeChain(error)) {
    for (const [field, label] of PG_ERROR_FIELDS) {
      if (seen.has(label)) continue
      const value = readString((link as Record<string, unknown>)[field])
      if (value === null) continue
      seen.add(label)
      lines.push(`  ${`${label}:`.padEnd(11)} ${value}`)
    }
  }

  const statement = failingStatementOf(error)
  if (statement) {
    lines.push("", "  failing statement:")
    for (const line of statement.split("\n")) lines.push(`    ${line}`)
  }

  lines.push(
    "",
    "  Nothing was applied. drizzle runs every pending migration in one",
    "  transaction, so the database is unchanged and it is safe to fix the",
    "  migration and run again.",
  )
  return lines.join("\n")
}
