/**
 * Which database a migration run may touch — the pure part.
 *
 * `npm run db:migrate` used to read `MIGRATION_DATABASE_URL` from whatever
 * `.env.local` happened to hold, and that file is switched by hand between the
 * local database and production. A run meant for one could land on the other.
 * Each environment now has its own command, reads its own file, and is refused
 * when the connection string does not look like that environment:
 *
 *   development  `.env.development.local`, then `.env.local`; loopback hosts only
 *   test         `.env.test.local`; the database name must contain "test"
 *   production   `.env.prod.local`; never loopback, never a "test"
 *                database, and nothing is applied without the plan digest
 *                printed by a dry run
 *
 * A variable already set in the shell wins over every file (CI sets them that
 * way), and the same guards apply to it.
 *
 * Nothing here reads a clock, a file or a database.
 */
import { createHash } from "node:crypto"

/**
 * The run was refused before anything connected: the wrong environment, a
 * missing or malformed connection string, or a bad argument. Not a migration
 * failure, and reported as such.
 */
export class MigrationTargetRefusal extends Error {
  override name = "MigrationTargetRefusal"
}

export const MIGRATION_ENVIRONMENTS = ["development", "test", "production"] as const
export type MigrationEnvironment = (typeof MIGRATION_ENVIRONMENTS)[number]

/** Read in order; an earlier file wins over a later one. */
export const MIGRATION_ENV_FILES: Readonly<Record<MigrationEnvironment, readonly string[]>> = {
  development: [".env.development.local", ".env.local"],
  // Never `.env.local`: it points at the running application's database.
  test: [".env.test.local"],
  // Never `.env.local`: that file is the one switched between local and prod.
  // Deliberately not `.env.production.local`: `@next/env` loads that file, ahead
  // of `.env.local`, in every production-mode load — `next build`/`next start`
  // and every `loadEnvConfig(process.cwd())` tool (db:sync, db:studio, the tsx
  // scripts) — so a prod URL there would silently retarget all of them.
  production: [".env.prod.local"],
}

/**
 * The variables each environment takes its connection string from, first
 * match wins. Test prefers `TEST_DATABASE_URL` so the database migrated is the
 * one the integration suite runs against; CI sets `MIGRATION_DATABASE_URL`.
 */
export const MIGRATION_URL_VARIABLES: Readonly<Record<MigrationEnvironment, readonly string[]>> = {
  development: ["MIGRATION_DATABASE_URL"],
  test: ["TEST_DATABASE_URL", "MIGRATION_DATABASE_URL"],
  production: ["MIGRATION_DATABASE_URL"],
}

export type MigrationArgs = {
  environment: MigrationEnvironment | null
  confirm: string | null
}

export function parseMigrationArgs(argv: readonly string[]): MigrationArgs {
  let environment: MigrationEnvironment | null = null
  let confirm: string | null = null

  for (const arg of argv) {
    const [flag, ...rest] = arg.split("=")
    const value = rest.join("=")
    if (flag === "--env") {
      if (!isMigrationEnvironment(value)) {
        throw new MigrationTargetRefusal(
          `Unknown --env "${value}". Expected one of: ${MIGRATION_ENVIRONMENTS.join(", ")}.`,
        )
      }
      environment = value
    } else if (flag === "--confirm") {
      confirm = value || null
    } else {
      throw new MigrationTargetRefusal(`Unknown argument "${arg}".`)
    }
  }

  return { environment, confirm }
}

export function isMigrationEnvironment(value: string): value is MigrationEnvironment {
  return (MIGRATION_ENVIRONMENTS as readonly string[]).includes(value)
}

export type MigrationTarget = {
  url: string
  variable: string
}

/** The connection string for this environment, or why there is none. */
export function selectMigrationUrl(
  environment: MigrationEnvironment,
  env: Readonly<Record<string, string | undefined>>,
): MigrationTarget {
  for (const variable of MIGRATION_URL_VARIABLES[environment]) {
    const url = env[variable]?.trim()
    if (url) return { url, variable }
  }

  const variables = MIGRATION_URL_VARIABLES[environment].join(" or ")
  const files = MIGRATION_ENV_FILES[environment].join(", ")
  throw new MigrationTargetRefusal(
    `No ${environment} database configured: set ${variables} in ${files} or in the shell.`,
  )
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase())
}

function databaseNameOf(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ""))
}

function parseUrl(url: string): URL {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("not postgres")
    }
    return parsed
  } catch {
    // Never echo the string itself: it carries the password.
    throw new MigrationTargetRefusal("The migration connection string is not a valid postgres:// URL.")
  }
}

/**
 * Refuse a connection string that does not belong to `environment`. Returns
 * nothing; throws with the reason. The messages name the host and database,
 * never the credentials.
 */
export function assertTargetMatchesEnvironment(
  environment: MigrationEnvironment,
  url: string,
): void {
  const parsed = parseUrl(url)
  const host = parsed.hostname
  const database = databaseNameOf(parsed)
  const named = `${host}/${database}`

  if (environment === "development" && !isLoopbackHost(host)) {
    throw new MigrationTargetRefusal(
      `Refusing to run development migrations against ${named}: ` +
        "development migrates a database on this machine only (localhost). " +
        "Use db:migrate:prod for production.",
    )
  }

  if (environment === "test" && !/test/i.test(database)) {
    throw new MigrationTargetRefusal(
      `Refusing to run test migrations against ${named}: ` +
        'the database name must contain "test" (e.g. oneflowe_test).',
    )
  }

  if (environment === "production") {
    if (isLoopbackHost(host)) {
      throw new MigrationTargetRefusal(
        `Refusing to run production migrations against ${named}: that is a local database. ` +
          "Use db:migrate:dev.",
      )
    }
    if (/test/i.test(database)) {
      throw new MigrationTargetRefusal(
        `Refusing to run production migrations against ${named}: that is a test database. ` +
          "Use db:migrate:test.",
      )
    }
  }
}

/** Where we are pointed, with the password left out. */
export function describeMigrationTarget(url: string): string {
  const parsed = parseUrl(url)
  return `${parsed.host}/${databaseNameOf(parsed)} as ${decodeURIComponent(parsed.username)}`
}

/**
 * The digest a production run must be given to apply. It covers the target
 * (host, port, database, user) and the exact migrations pending, so a digest
 * printed against one database, or before another migration was added, does
 * not apply anything anywhere else.
 */
export function productionPlanDigest(url: string, pendingTags: readonly string[]): string {
  const parsed = parseUrl(url)
  const payload = JSON.stringify({
    host: parsed.host.toLowerCase(),
    database: databaseNameOf(parsed),
    user: decodeURIComponent(parsed.username),
    pending: pendingTags,
  })
  return createHash("sha256").update(payload).digest("hex").slice(0, 16)
}

/**
 * TLS for the migration connection, the same posture the application uses
 * (`lib/db-core.ts`): the Supabase pooler presents a certificate Node does
 * not trust, a local database needs none, and production must be trusted.
 */
export function migrationSslFor(
  environment: MigrationEnvironment,
  url: string,
): false | { rejectUnauthorized: boolean } {
  const { hostname } = parseUrl(url)
  if (hostname.includes("supabase")) return { rejectUnauthorized: false }
  if (isLoopbackHost(hostname)) return false
  return environment === "production" ? { rejectUnauthorized: true } : false
}

export const MIGRATE_USAGE = [
  "Choose the environment to migrate:",
  "  npm run db:migrate:dev    local database (.env.development.local, then .env.local)",
  "  npm run db:migrate:test   disposable test database (.env.test.local)",
  "  npm run db:migrate:prod   production (.env.prod.local) — dry run;",
  "                            re-run with -- --confirm=<digest> to apply",
].join("\n")
