/**
 * Pure planning logic for correcting `users.full_name` / `first_name` /
 * `last_name` from a reviewed copy of the portal's user-directory export.
 *
 * The export carries no user id, and an email is not unique in a mirrored
 * tenant — one K-Electric address can front nine different people, one account
 * per role. The identifying key is therefore (email, role, branch), and a plan
 * is refused unless that key resolves to exactly one row on both sides.
 *
 * Kept free of database and filesystem access so the rules can be tested
 * directly; `scripts/fix-user-names-from-export.ts` supplies the rows.
 */

/** Longest value `users.full_name` accepts. */
export const MAX_FULL_NAME = 255
/** Longest value `users.first_name` and `users.last_name` accept. */
export const MAX_PART_NAME = 100

export interface SheetRow {
  /** Zero-based position in the sheet body; row `index + 2` in the spreadsheet. */
  index: number
  name: string
  email: string
  role: string
  branch: string
  phone: string
}

export interface UserRow {
  id: string
  email: string
  username: string | null
  employeeId: string | null
  fullName: string | null
  firstName: string | null
  lastName: string | null
  phone: string | null
  role: string
  branch: string | null
}

export interface NameParts {
  fullName: string
  firstName: string
  lastName: string | null
}

export interface PlanRow {
  userId: string
  email: string
  role: string
  branch: string
  username: string | null
  employeeId: string | null
  before: { fullName: string | null; firstName: string | null; lastName: string | null }
  after: NameParts
}

export type SkipReason = "NAME_CONFLICT_BETWEEN_ROLE_ROWS" | "NO_MATCHING_ACCOUNT"

export interface SkippedRow {
  reason: SkipReason
  sheetIndex: number
  email: string
  role: string
  branch: string
  name: string
  detail: string
}

export interface UnmatchedUser {
  id: string
  email: string
  role: string
  branch: string | null
  fullName: string | null
}

export interface NameCorrectionPlan {
  plan: PlanRow[]
  skipped: SkippedRow[]
  /** Accounts whose three name columns already hold the sheet's values. */
  unchanged: number
  unmatchedDbUsers: UnmatchedUser[]
}

/** Raised when the sheet cannot be trusted to identify the rows it addresses. */
export class NameCorrectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NameCorrectionError"
  }
}

function fail(message: string): never {
  throw new NameCorrectionError(message)
}

/** Collapses runs of whitespace and trims. Applied identically to both sides. */
export function text(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

/**
 * Drops the lone trailing dash legacy names sometimes end in ("Imran Khan -"),
 * with the whitespace around it. Anything else is returned untouched.
 *
 * Exactly `value.replace(/\s*-\s*$/, "")`, written without the regex: that
 * pattern backtracks quadratically on a long run of whitespace. `trimEnd`
 * removes the same characters `\s` matches.
 */
export function withoutTrailingDash(value: string): string {
  const trimmed = value.trimEnd()
  return trimmed.endsWith("-") ? trimmed.slice(0, -1).trimEnd() : value
}

export function emailKey(value: unknown): string {
  return text(value).toLowerCase()
}

/** Branch display names are compared case-insensitively after collapsing space. */
export function branchKey(value: unknown): string {
  return text(value).toLowerCase()
}

/**
 * Digits only. The spreadsheet renders a null phone as an em dash, which must
 * compare equal to a null column rather than to the literal characters.
 */
export function phoneDigits(value: unknown): string {
  const raw = text(value)
  if (!raw || raw === "—" || raw === "-") return ""
  return raw.replace(/\D/g, "")
}

export function matchKey(email: unknown, role: unknown, branch: unknown): string {
  return `${emailKey(email)}|${text(role).toUpperCase()}|${branchKey(branch)}`
}

/**
 * First token is the given name; everything after it is the family name.
 * A single-token name yields a null `lastName` — the reviewer's decision, so
 * that "KASHIF" does not silently keep a stale surname.
 */
export function splitName(fullName: string): NameParts {
  const parts = text(fullName).split(" ").filter(Boolean)
  return {
    fullName: parts.join(" "),
    firstName: parts[0] ?? "",
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
  }
}

/** Stable stringification so the plan digest does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function assertUniqueKeys<T>(
  items: T[],
  keyOf: (item: T) => string,
  describe: (item: T) => string,
  subject: string,
): Map<string, T> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const collisions = [...groups.entries()].filter(([, group]) => group.length > 1)
  if (collisions.length > 0) {
    fail(
      `${subject} has ${collisions.length} group(s) sharing an (email, role, branch) key, so they cannot be told apart: ` +
        collisions
          .map(([key, group]) => `${key} -> ${group.map(describe).join(", ")}`)
          .join("; "),
    )
  }
  return new Map([...groups].map(([key, group]) => [key, group[0]!]))
}

/**
 * A person is one email at one branch; their role rows must agree on a name.
 * Where they disagree we cannot tell which the reviewer meant, so neither row
 * is written.
 */
function findNameConflicts(sheet: SheetRow[]): { conflicted: Set<number>; skipped: SkippedRow[] } {
  const namesByPerson = new Map<string, Map<string, SheetRow[]>>()
  for (const row of sheet) {
    const person = `${emailKey(row.email)}|${branchKey(row.branch)}`
    const names = namesByPerson.get(person) ?? new Map<string, SheetRow[]>()
    names.set(row.name, [...(names.get(row.name) ?? []), row])
    namesByPerson.set(person, names)
  }

  const conflicted = new Set<number>()
  const skipped: SkippedRow[] = []
  for (const [person, names] of namesByPerson) {
    if (names.size <= 1) continue
    const detail = `${person} carries ${names.size} different names: ${[...names.keys()]
      .map((name) => JSON.stringify(name))
      .join(" vs ")}`
    for (const row of [...names.values()].flat()) {
      conflicted.add(row.index)
      skipped.push({
        reason: "NAME_CONFLICT_BETWEEN_ROLE_ROWS",
        sheetIndex: row.index,
        email: row.email,
        role: row.role,
        branch: row.branch,
        name: row.name,
        detail,
      })
    }
  }
  return { conflicted, skipped }
}

/** Refuses a name the columns cannot hold, or one that would blank the account. */
function assertWritable(after: NameParts, sheetIndex: number): void {
  const row = sheetIndex + 2
  // Checked after normalisation: a cell of spaces must not blank the account.
  if (!after.fullName) fail(`Sheet row ${row} has an empty Name`)
  if (after.fullName.length > MAX_FULL_NAME) fail(`Sheet row ${row}: full name exceeds ${MAX_FULL_NAME} characters`)
  if (after.firstName.length > MAX_PART_NAME) fail(`Sheet row ${row}: first name exceeds ${MAX_PART_NAME} characters`)
  if ((after.lastName ?? "").length > MAX_PART_NAME) fail(`Sheet row ${row}: last name exceeds ${MAX_PART_NAME} characters`)
}

function isUnchanged(user: UserRow, after: NameParts): boolean {
  return user.fullName === after.fullName
    && user.firstName === after.firstName
    && user.lastName === after.lastName
}

/**
 * Builds the set of name updates. Throws `NameCorrectionError` when the sheet
 * cannot safely address the accounts — ambiguous keys, or a `phone` that no
 * longer confirms the match.
 */
export function buildNameCorrectionPlan(sheet: SheetRow[], users: UserRow[]): NameCorrectionPlan {
  assertUniqueKeys(
    sheet,
    (row) => matchKey(row.email, row.role, row.branch),
    (row) => `sheet row ${row.index + 2} "${row.name}"`,
    "Sheet",
  )
  const userByKey = assertUniqueKeys(
    users,
    (user) => matchKey(user.email, user.role, user.branch),
    (user) => `account ${user.id} "${user.fullName}"`,
    "Database",
  )

  const { conflicted, skipped } = findNameConflicts(sheet)
  const plan: PlanRow[] = []
  const matchedUserIds = new Set<string>()
  const phoneMismatches: string[] = []
  let unchanged = 0

  for (const row of sheet) {
    const key = matchKey(row.email, row.role, row.branch)
    const user = userByKey.get(key)

    if (!user) {
      skipped.push({
        reason: "NO_MATCHING_ACCOUNT",
        sheetIndex: row.index,
        email: row.email,
        role: row.role,
        branch: row.branch,
        name: row.name,
        detail: `No active account for ${key}`,
      })
      continue
    }
    matchedUserIds.add(user.id)

    // Independent confirmation: the sheet was generated from these same rows,
    // so a disagreement means it no longer describes them.
    if (phoneDigits(row.phone) !== phoneDigits(user.phone)) {
      phoneMismatches.push(
        `sheet row ${row.index + 2} <${row.email}> ${row.role} / ${row.branch}: ` +
          `sheet phone ${JSON.stringify(row.phone)} vs database ${JSON.stringify(user.phone)} (account ${user.id})`,
      )
      continue
    }

    if (conflicted.has(row.index)) continue

    const after = splitName(row.name)
    assertWritable(after, row.index)

    if (isUnchanged(user, after)) {
      unchanged++
      continue
    }

    plan.push({
      userId: user.id,
      email: user.email,
      role: user.role,
      branch: user.branch ?? "",
      username: user.username,
      employeeId: user.employeeId,
      before: { fullName: user.fullName, firstName: user.firstName, lastName: user.lastName },
      after,
    })
  }

  if (phoneMismatches.length > 0) {
    fail(
      `Phone does not confirm the match on ${phoneMismatches.length} row(s). The sheet no longer describes ` +
        `these accounts, so the identification is not trustworthy. Resolve these before running again:\n  - ` +
        phoneMismatches.join("\n  - "),
    )
  }

  const unmatchedDbUsers = users
    .filter((user) => !matchedUserIds.has(user.id))
    .map((user) => ({ id: user.id, email: user.email, role: user.role, branch: user.branch, fullName: user.fullName }))

  plan.sort((a, b) => a.userId.localeCompare(b.userId))
  skipped.sort((a, b) => a.sheetIndex - b.sheetIndex)
  return { plan, skipped, unchanged, unmatchedDbUsers }
}
