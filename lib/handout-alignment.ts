/**
 * Pure planning logic for aligning a tenant's accounts to a credential
 * hand-out: each hand-out row names the account (employee code + portal
 * suffix), the corrected display name, and the username the person has been
 * told to use. The password on the row is verified against the stored hash by
 * the caller; only a verified row is planned, because the password is what
 * proves the row describes that account.
 *
 * Kept free of database, filesystem and bcrypt access so the rules can be
 * tested directly; `scripts/align-accounts-to-handout.ts` supplies the rows
 * and performs the verification and the write.
 */

import { MAX_FULL_NAME, MAX_PART_NAME, emailKey, splitName, text, type NameParts } from "./user-name-correction"
import { MAX_USERNAME, roleSuffix } from "./username-generation"

export interface HandoutRow {
  /** Zero-based position in the sheet body; row `index + 2` in the spreadsheet. */
  index: number
  name: string
  email: string
  branch: string
  username: string
  loginCode: string
  /**
   * The code the target account actually carries in `external_id`, when it is
   * not the legacy login code — a placeholder given to a new holder of a
   * legacy login whose previous holder kept the original account. Matching
   * uses this; `loginCode` stays what the person is told and what the drift
   * report compares.
   */
  accountCode?: string
  mustChangePassword: boolean
}

export interface AlignmentAccount {
  id: string
  email: string
  role: string
  branch: string | null
  username: string | null
  externalId: string | null
  fullName: string | null
  firstName: string | null
  lastName: string | null
  isActive: boolean
  mustChangePassword: boolean
}

/** Every username in the table, other tenants and soft-deleted rows included. */
export interface ExistingUsername {
  id: string
  username: string | null
}

export type MatchedBy = "login_code" | "email"

export interface HandoutMatch {
  row: HandoutRow
  account: AlignmentAccount
  matchedBy: MatchedBy
}

export type MatchSkipReason =
  | "UNSUPPORTED_USERNAME_SUFFIX"
  | "NO_ACCOUNT"
  | "AMBIGUOUS_ACCOUNT"
  | "ACCOUNT_CLAIMED_TWICE"

export interface MatchSkippedRow {
  sheetIndex: number
  username: string
  name: string
  reason: MatchSkipReason
  detail: string
}

export interface MatchResult {
  matches: HandoutMatch[]
  skipped: MatchSkippedRow[]
  /** Accounts of the tenant that no hand-out row addressed. */
  unmatchedAccounts: AlignmentAccount[]
}

export interface VerifiedMatch extends HandoutMatch {
  passwordVerified: boolean
}

/** Things the alignment deliberately leaves alone, reported per account. */
export type RemainingIssue =
  | "BRANCH_DIFFERS"
  | "EXTERNAL_ID_DIFFERS_FROM_LOGIN_CODE"
  | "MUST_CHANGE_PASSWORD_DIFFERS"
  | "ACCOUNT_INACTIVE"

export interface AlignmentPlanRow {
  userId: string
  sheetIndex: number
  email: string
  role: string
  branch: string
  matchedBy: MatchedBy
  before: { username: string | null; fullName: string | null; firstName: string | null; lastName: string | null }
  after: { username: string } & NameParts
  usernameChanges: boolean
  nameChanges: boolean
  remaining: RemainingIssue[]
}

export type PlanSkipReason =
  | "PASSWORD_MISMATCH"
  | "INVALID_TARGET_USERNAME"
  | "USERNAME_TAKEN"
  | "EMPTY_NAME"
  | "NAME_TOO_LONG"

export interface PlanSkippedRow {
  sheetIndex: number
  userId: string
  username: string
  name: string
  role: string
  reason: PlanSkipReason
  detail: string
}

export interface AlignmentPlan {
  plan: AlignmentPlanRow[]
  skipped: PlanSkippedRow[]
  /** Verified rows whose account already carries every value. */
  unchanged: AlignmentPlanRow[]
}

export class HandoutAlignmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HandoutAlignmentError"
  }
}

function fail(message: string): never {
  throw new HandoutAlignmentError(message)
}

/** Employee codes are compared as digits-and-letters, case-insensitively. */
export function codeKey(value: unknown): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** The portal role a hand-out username addresses, from its `-ba` / `-op` tail. */
export function roleOfUsername(username: unknown): string | null {
  const suffix = /-([a-z]+)$/.exec(text(username).toLowerCase())?.[1]
  if (!suffix) return null
  for (const role of ["BRANCH_ADMIN", "ORDER_PORTAL"]) {
    if (roleSuffix(role) === suffix) return role
  }
  return null
}

/** The shape `fix:usernames` produces; anything else is not a hand-out username. */
const USERNAME_SHAPE = /^[a-z0-9]+-[a-z0-9]+-(ba|op)$/

export function isHandoutUsername(value: unknown, role: string): boolean {
  const username = text(value)
  return username.length <= MAX_USERNAME
    && USERNAME_SHAPE.test(username)
    && username.endsWith(`-${roleSuffix(role) ?? ""}`)
}

function claimHandoutMatch({
  row,
  candidates,
  matchedBy,
  role,
  matches,
  skipped,
  claimedBy,
}: {
  row: HandoutRow
  candidates: AlignmentAccount[]
  matchedBy: MatchedBy
  role: string
  matches: HandoutMatch[]
  skipped: MatchSkippedRow[]
  claimedBy: Map<string, number>
}): void {
  if (candidates.length > 1) {
    skipped.push({ sheetIndex: row.index, username: row.username, name: row.name, reason: "AMBIGUOUS_ACCOUNT",
      detail: `${candidates.length} ${role} accounts match by ${matchedBy}: ${candidates.map((candidate) => candidate.username ?? candidate.id).join(", ")}` })
    return
  }
  const account = candidates[0]!
  const earlier = claimedBy.get(account.id)
  if (earlier !== undefined) {
    skipped.push({ sheetIndex: row.index, username: row.username, name: row.name, reason: "ACCOUNT_CLAIMED_TWICE",
      detail: `Account ${account.username ?? account.id} was already matched by sheet row ${earlier + 2}` })
    return
  }
  claimedBy.set(account.id, row.index)
  matches.push({ row, account, matchedBy })
}

function indexAccounts(accounts: AlignmentAccount[]) {
  const byCodeAndRole = new Map<string, AlignmentAccount[]>()
  const byEmailAndRole = new Map<string, AlignmentAccount[]>()
  for (const account of accounts) {
    const code = codeKey(account.externalId)
    if (code) {
      const key = `${code}|${account.role}`
      byCodeAndRole.set(key, [...(byCodeAndRole.get(key) ?? []), account])
    }
    const email = emailKey(account.email)
    if (email) {
      const key = `${email}|${account.role}`
      byEmailAndRole.set(key, [...(byEmailAndRole.get(key) ?? []), account])
    }
  }
  return { byCodeAndRole, byEmailAndRole }
}

/**
 * Resolves every hand-out row to at most one account. The employee code and
 * portal suffix identify a mirrored account directly; when the tenant's
 * `external_id` does not carry the code (truncated or a placeholder), the
 * email and role must identify it alone. Anything ambiguous is refused.
 */
export function matchHandoutRows(rows: HandoutRow[], accounts: AlignmentAccount[]): MatchResult {
  const { byCodeAndRole, byEmailAndRole } = indexAccounts(accounts)

  const matches: HandoutMatch[] = []
  const skipped: MatchSkippedRow[] = []
  const claimedBy = new Map<string, number>()

  // Two passes: every login-code match is settled before any email fallback
  // runs, so a row whose own account is gone cannot take another row's account
  // just because the two share an email.
  const fallback: Array<{ row: HandoutRow; role: string }> = []
  for (const row of rows) {
    const role = roleOfUsername(row.username)
    if (!role) {
      skipped.push({ sheetIndex: row.index, username: row.username, name: row.name,
        reason: "UNSUPPORTED_USERNAME_SUFFIX", detail: "Username does not end in -ba or -op" })
      continue
    }
    const code = codeKey(row.accountCode) || codeKey(row.loginCode)
    const candidates = code ? byCodeAndRole.get(`${code}|${role}`) ?? [] : []
    if (candidates.length === 0) fallback.push({ row, role })
    else claimHandoutMatch({ row, candidates, matchedBy: "login_code", role, matches, skipped, claimedBy })
  }

  for (const { row, role } of fallback) {
    const candidates = (emailKey(row.email) ? byEmailAndRole.get(`${emailKey(row.email)}|${role}`) ?? [] : [])
      .filter((account) => !claimedBy.has(account.id))
    if (candidates.length === 0) {
      skipped.push({ sheetIndex: row.index, username: row.username, name: row.name, reason: "NO_ACCOUNT",
        detail: `No ${role} account carries login code ${JSON.stringify(row.loginCode)}, and none with email ${JSON.stringify(row.email)} is unclaimed` })
      continue
    }
    claimHandoutMatch({ row, candidates, matchedBy: "email", role, matches, skipped, claimedBy })
  }

  matches.sort((a, b) => a.row.index - b.row.index)
  skipped.sort((a, b) => a.sheetIndex - b.sheetIndex)
  const unmatchedAccounts = accounts.filter((account) => !claimedBy.has(account.id))
  return { matches, skipped, unmatchedAccounts }
}

function remainingIssues(row: HandoutRow, account: AlignmentAccount): RemainingIssue[] {
  const issues: RemainingIssue[] = []
  if (text(row.branch).toLowerCase() !== text(account.branch).toLowerCase()) issues.push("BRANCH_DIFFERS")
  if (codeKey(row.loginCode) !== codeKey(account.externalId)) issues.push("EXTERNAL_ID_DIFFERS_FROM_LOGIN_CODE")
  if (row.mustChangePassword !== account.mustChangePassword) issues.push("MUST_CHANGE_PASSWORD_DIFFERS")
  if (!account.isActive) issues.push("ACCOUNT_INACTIVE")
  return issues
}

function alignmentPlanSkip(
  match: VerifiedMatch,
  username: string,
  after: NameParts,
  holders: Map<string, string>,
  plannedIds: Set<string>,
): PlanSkippedRow | null {
  const { row, account, passwordVerified } = match
  const base = { sheetIndex: row.index, userId: account.id, username: row.username, name: row.name, role: account.role }
  if (!passwordVerified) {
    return { ...base, reason: "PASSWORD_MISMATCH", detail: "The hand-out password does not authenticate this account; the row cannot be trusted to describe it" }
  }
  if (!isHandoutUsername(username, account.role)) {
    return { ...base, reason: "INVALID_TARGET_USERNAME", detail: `${JSON.stringify(username)} is not a <name>-<code>-${roleSuffix(account.role)} username` }
  }
  const holder = holders.get(username)
  if (holder !== undefined && holder !== account.id && !plannedIds.has(holder)) {
    return { ...base, reason: "USERNAME_TAKEN", detail: `${JSON.stringify(username)} is already held by account ${holder}, which this plan does not rename` }
  }
  if (!after.fullName) return { ...base, reason: "EMPTY_NAME", detail: "The hand-out Name is empty" }
  if (after.fullName.length > MAX_FULL_NAME || after.firstName.length > MAX_PART_NAME
    || (after.lastName ?? "").length > MAX_PART_NAME) {
    return { ...base, reason: "NAME_TOO_LONG", detail: `Name exceeds ${MAX_FULL_NAME}/${MAX_PART_NAME} characters` }
  }
  return null
}

/**
 * Builds the set of username and name updates from verified matches. Throws
 * `HandoutAlignmentError` when the hand-out itself is unusable — two rows
 * claiming one username.
 */
export function buildAlignmentPlan(matches: VerifiedMatch[], existing: ExistingUsername[]): AlignmentPlan {
  const targets = new Map<string, number>()
  for (const { row } of matches) {
    const username = text(row.username)
    const earlier = targets.get(username)
    if (earlier !== undefined) {
      fail(`Hand-out rows ${earlier + 2} and ${row.index + 2} both carry username ${JSON.stringify(username)}`)
    }
    targets.set(username, row.index)
  }

  const holders = new Map<string, string>()
  for (const account of existing) {
    if (account.username) holders.set(account.username, account.id)
  }
  const plannedIds = new Set(matches.filter((m) => m.passwordVerified).map((m) => m.account.id))

  const plan: AlignmentPlanRow[] = []
  const unchanged: AlignmentPlanRow[] = []
  const skipped: PlanSkippedRow[] = []

  for (const match of matches) {
    const { row, account, matchedBy } = match
    const username = text(row.username)
    const after = splitName(row.name)
    const skippedRow = alignmentPlanSkip(match, username, after, holders, plannedIds)
    if (skippedRow) {
      skipped.push(skippedRow)
      continue
    }

    const usernameChanges = account.username !== username
    const nameChanges = account.fullName !== after.fullName
      || account.firstName !== after.firstName
      || account.lastName !== after.lastName

    const planned: AlignmentPlanRow = {
      userId: account.id,
      sheetIndex: row.index,
      email: account.email,
      role: account.role,
      branch: account.branch ?? "",
      matchedBy,
      before: { username: account.username, fullName: account.fullName, firstName: account.firstName, lastName: account.lastName },
      after: { username, ...after },
      usernameChanges,
      nameChanges,
      remaining: remainingIssues(row, account),
    }
    if (usernameChanges || nameChanges) plan.push(planned)
    else unchanged.push(planned)
  }

  plan.sort((a, b) => a.userId.localeCompare(b.userId))
  skipped.sort((a, b) => a.sheetIndex - b.sheetIndex)
  return { plan, skipped, unchanged }
}
