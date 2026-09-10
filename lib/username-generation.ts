/**
 * Pure rules for rebuilding `users.username` as
 * `<first name>-<employee code>-<ba|op>`.
 *
 * Two constraints shape this and neither is negotiable:
 *
 * - `users_username_idx` is unique across the **whole** table, not per tenant,
 *   so a generated name must not collide with any account anywhere.
 * - `lib/auth-options.ts` lowercases the submitted credential before matching
 *   the column exactly, so a stored username containing an uppercase letter can
 *   never be signed in with. Everything here is lowercased.
 *
 * A first name alone does not identify anyone here — nineteen K-Electric staff
 * are called Muhammad — so the employee code carries the uniqueness and the
 * name carries the readability. An account missing either part is reported and
 * left alone rather than guessed at.
 *
 * Kept free of database access so the rules can be tested directly;
 * `scripts/regenerate-usernames.ts` supplies the rows.
 */

/** Longest value `users.username` accepts. */
export const MAX_USERNAME = 255

/** The two portal roles this rule covers, and the suffix each one carries. */
export const ROLE_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  BRANCH_ADMIN: "ba",
  ORDER_PORTAL: "op",
})

export interface UsernameSourceRow {
  id: string
  email: string
  role: string
  firstName: string | null
  fullName: string | null
  employeeId: string | null
  username: string | null
  branch: string | null
}

/** Any account in the table, used to prove the generated name is free. */
export interface ExistingUsername {
  id: string
  username: string | null
}

export interface UsernamePlanRow {
  userId: string
  email: string
  role: string
  branch: string
  fullName: string | null
  employeeId: string
  before: string | null
  after: string
}

export type UsernameSkipReason =
  | "MISSING_FIRST_NAME"
  | "MISSING_EMPLOYEE_CODE"
  | "UNSUPPORTED_ROLE"

export interface UsernameSkippedRow {
  reason: UsernameSkipReason
  userId: string
  email: string
  role: string
  branch: string | null
  fullName: string | null
  currentUsername: string | null
  detail: string
}

export interface UsernamePlan {
  plan: UsernamePlanRow[]
  skipped: UsernameSkippedRow[]
  /** Accounts already holding exactly the name the rule produces. */
  unchanged: number
}

/** Raised when the rule cannot produce a safe, unique set of usernames. */
export class UsernameGenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsernameGenerationError"
  }
}

function fail(message: string): never {
  throw new UsernameGenerationError(message)
}

/**
 * Reduces one name or code to the characters a username may carry: lowercase
 * letters and digits. "Imran-ul-Hassan" becomes "imranulhassan", so the hyphens
 * in the result are only ever the rule's own separators.
 */
export function slugToken(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
}

/** The suffix for a role, or null where the rule does not cover it. */
export function roleSuffix(role: unknown): string | null {
  return ROLE_SUFFIX[String(role ?? "").trim().toUpperCase()] ?? null
}

/**
 * Builds the username for one account, or returns null with the reason it
 * cannot be built.
 */
export function buildUsername(
  firstName: unknown,
  employeeId: unknown,
  role: unknown,
): { username: string } | { error: UsernameSkipReason } {
  const suffix = roleSuffix(role)
  if (!suffix) return { error: "UNSUPPORTED_ROLE" }

  const name = slugToken(firstName)
  if (!name) return { error: "MISSING_FIRST_NAME" }

  const code = slugToken(employeeId)
  if (!code) return { error: "MISSING_EMPLOYEE_CODE" }

  return { username: `${name}-${code}-${suffix}` }
}

function skipDetail(reason: UsernameSkipReason, row: UsernameSourceRow): string {
  if (reason === "UNSUPPORTED_ROLE") return `Role ${JSON.stringify(row.role)} has no username rule`
  if (reason === "MISSING_FIRST_NAME") return "first_name has no usable characters"
  return "employee_id has no usable characters"
}

function toSkipped(row: UsernameSourceRow, reason: UsernameSkipReason): UsernameSkippedRow {
  return {
    reason,
    userId: row.id,
    email: row.email,
    role: row.role,
    branch: row.branch,
    fullName: row.fullName,
    currentUsername: row.username,
    detail: skipDetail(reason, row),
  }
}

/**
 * Names held by accounts this run will not touch. They stay claimed throughout,
 * including those of other tenants and of soft-deleted rows, because the unique
 * index covers the whole table.
 */
function claimsOutsideRun(allAccounts: ExistingUsername[], targetIds: Set<string>): Map<string, string> {
  const claimedBy = new Map<string, string>()
  for (const account of allAccounts) {
    if (targetIds.has(account.id)) continue
    const existing = String(account.username ?? "").trim().toLowerCase()
    if (existing) claimedBy.set(existing, account.id)
  }
  return claimedBy
}

/**
 * Builds the set of username changes for `targets`, proving every generated
 * name is free across `allAccounts` — which must cover the entire users table,
 * because the unique index is global rather than per tenant.
 *
 * Throws `UsernameGenerationError` when the rule would produce a duplicate,
 * rather than letting the database reject one row of a half-applied batch.
 */
export function buildUsernamePlan(
  targets: UsernameSourceRow[],
  allAccounts: ExistingUsername[],
): UsernamePlan {
  const targetIds = new Set(targets.map((row) => row.id))
  if (targets.length > targetIds.size) {
    fail(`Target set contains ${targets.length - targetIds.size} duplicate account id(s)`)
  }

  const claimedBy = claimsOutsideRun(allAccounts, targetIds)
  const plan: UsernamePlanRow[] = []
  const skipped: UsernameSkippedRow[] = []
  let unchanged = 0

  for (const row of targets) {
    const built = buildUsername(row.firstName, row.employeeId, row.role)

    if ("error" in built) {
      skipped.push(toSkipped(row, built.error))
      continue
    }

    const { username } = built
    if (username.length > MAX_USERNAME) {
      fail(`Account ${row.id} would need a ${username.length}-character username, over the ${MAX_USERNAME} limit`)
    }

    const owner = claimedBy.get(username)
    if (owner && owner !== row.id) {
      fail(
        `Username ${JSON.stringify(username)} is wanted by account ${row.id} but already held by ${owner}. ` +
          `first_name plus employee_id does not identify these accounts uniquely; resolve the duplicate before running again.`,
      )
    }
    claimedBy.set(username, row.id)

    if (row.username === username) {
      unchanged++
      continue
    }

    plan.push({
      userId: row.id,
      email: row.email,
      role: String(row.role).toUpperCase(),
      branch: row.branch ?? "",
      fullName: row.fullName,
      employeeId: String(row.employeeId),
      before: row.username,
      after: username,
    })
  }

  plan.sort((a, b) => a.userId.localeCompare(b.userId))
  skipped.sort((a, b) => a.userId.localeCompare(b.userId))
  return { plan, skipped, unchanged }
}
