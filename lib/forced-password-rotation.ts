/**
 * Planning a forced password rotation for one tenant's accounts.
 *
 * Pure: the script (`scripts/force-password-rotation.ts`) reads the rows,
 * this decides, the script writes what was decided and nothing else. Every
 * decision is a line in the plan so the digest a dry run prints changes when
 * any of them would.
 *
 * Flagging an account means `must_change_password = true` and
 * `session_version + 1`. The flag alone would not reach a session that is
 * already open — it travels in the JWT from sign-in time — so the version bump
 * is what actually forces everyone through the change.
 *
 * See `plans/OF-KE-forced-password-rotation.md`.
 */

import { isRoutableEmailAddress } from "@/lib/validation/email"

export interface RotationAccount {
  id: string
  username: string | null
  email: string
  role: string
  externalSource: string | null
  externalId: string | null
  isActive: boolean
  mustChangePassword: boolean
  sessionVersion: number
  passwordChangedAt: Date | string | null
}

export interface RotationOptions {
  /** Roles to flag. Everything else in the population is left alone. */
  roles: readonly string[]
  /**
   * `external_source` values to flag. `null` means an account created in the
   * portal, which is never selected by this planner: the rotation is for
   * mirrored accounts whose passwords were handed out, and `*_RETIRED`
   * holders are excluded by not being named here.
   */
  externalSources: readonly string[]
  /** Pin the run to named accounts (a pilot). Case-insensitive. */
  usernames?: readonly string[]
  /**
   * Flag accounts whose address cannot receive mail. Off by default because
   * a flagged account with no reachable address is locked out until an
   * administrator corrects it.
   */
  includeUnroutable: boolean
}

export type RotationSkipReason =
  | "ALREADY_FLAGGED"
  | "EMAIL_UNROUTABLE"
  | "INACTIVE"
  | "NOT_SELECTED"

export interface RotationTarget {
  id: string
  username: string | null
  email: string
  role: string
  externalId: string | null
  /** `session_version` as read; the write is pinned to it. */
  sessionVersion: number
  /** Another person's account carries the same address. */
  emailShared: boolean
  /** The address cannot receive mail; only present with `includeUnroutable`. */
  emailUnroutable: boolean
}

export interface RotationSkip {
  id: string | null
  username: string | null
  email: string | null
  role: string | null
  reason: RotationSkipReason
  detail: string
}

export interface SharedEmailWarning {
  email: string
  /** Distinct people (by `external_id`, or account id when unstamped). */
  people: number
  usernames: string[]
}

export interface ForcedPasswordRotationPlan {
  targets: RotationTarget[]
  skipped: RotationSkip[]
  sharedEmails: SharedEmailWarning[]
}

function normalizeUsername(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase()
}

function normalizeEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase()
}

function personKey(account: Pick<RotationAccount, "id" | "externalSource" | "externalId">): string {
  return account.externalSource && account.externalId
    ? `${account.externalSource}:${account.externalId}`
    : `account:${account.id}`
}

function byUsername<T extends { username: string | null; id: string }>(a: T, b: T): number {
  return normalizeUsername(a.username).localeCompare(normalizeUsername(b.username)) || a.id.localeCompare(b.id)
}

/**
 * Addresses used by more than one person across the whole population given —
 * not only the accounts being flagged, because the concern is who else can
 * read the code, and that person may hold a role this run does not touch.
 */
export function findSharedEmails(accounts: readonly RotationAccount[]): SharedEmailWarning[] {
  const byEmail = new Map<string, { people: Set<string>; usernames: Set<string> }>()
  for (const account of accounts) {
    if (!account.isActive) continue
    const email = normalizeEmail(account.email)
    if (!email) continue
    const entry = byEmail.get(email) ?? { people: new Set<string>(), usernames: new Set<string>() }
    entry.people.add(personKey(account))
    if (account.username) entry.usernames.add(account.username)
    byEmail.set(email, entry)
  }
  return [...byEmail.entries()]
    .filter(([, entry]) => entry.people.size > 1)
    .map(([email, entry]) => ({
      email,
      people: entry.people.size,
      usernames: [...entry.usernames].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.email.localeCompare(b.email))
}

type Selection = {
  roles: Set<string>
  sources: Set<string>
  /** Null when the run is not pinned to named accounts. */
  pinned: Set<string> | null
  includeUnroutable: boolean
  sharedEmails: Set<string>
}

function skip(account: RotationAccount, reason: RotationSkipReason, detail: string): RotationSkip {
  return { id: account.id, username: account.username, email: account.email, role: account.role, reason, detail }
}

/** One account's fate: a target, a skip worth reporting, or nothing (outside the population). */
function classifyAccount(
  account: RotationAccount,
  selection: Selection,
): { target: RotationTarget } | { skip: RotationSkip } | null {
  const inPopulation = selection.roles.has(account.role)
    && account.externalSource !== null
    && selection.sources.has(account.externalSource)
  const pinnedHere = selection.pinned === null || selection.pinned.has(normalizeUsername(account.username))

  if (!inPopulation) {
    // A pinned name outside the population is a mistake worth saying.
    return selection.pinned !== null && pinnedHere
      ? { skip: skip(account, "NOT_SELECTED", `role ${account.role}, external_source ${account.externalSource ?? "null"} is outside the population`) }
      : null
  }
  if (!pinnedHere) return null
  if (!account.isActive) return { skip: skip(account, "INACTIVE", "account is inactive") }
  if (account.mustChangePassword) return { skip: skip(account, "ALREADY_FLAGGED", "must_change_password is already set") }

  const unroutable = !isRoutableEmailAddress(account.email)
  if (unroutable && !selection.includeUnroutable) {
    return { skip: skip(account, "EMAIL_UNROUTABLE", "no reachable email address; flagging would lock the account out (pass --include-unroutable to do it anyway)") }
  }

  return {
    target: {
      id: account.id,
      username: account.username,
      email: account.email,
      role: account.role,
      externalId: account.externalId,
      sessionVersion: account.sessionVersion,
      emailShared: selection.sharedEmails.has(normalizeEmail(account.email)),
      emailUnroutable: unroutable,
    },
  }
}

export function planForcedPasswordRotation(
  accounts: readonly RotationAccount[],
  options: RotationOptions,
): ForcedPasswordRotationPlan {
  const sharedEmails = findSharedEmails(accounts)
  const selection: Selection = {
    roles: new Set(options.roles),
    sources: new Set(options.externalSources),
    pinned: options.usernames?.length
      ? new Set(options.usernames.map(normalizeUsername).filter(Boolean))
      : null,
    includeUnroutable: options.includeUnroutable,
    sharedEmails: new Set(sharedEmails.map((entry) => entry.email)),
  }

  const targets: RotationTarget[] = []
  const skipped: RotationSkip[] = []
  const seenPinned = new Set<string>()

  for (const account of [...accounts].sort(byUsername)) {
    if (selection.pinned?.has(normalizeUsername(account.username))) seenPinned.add(normalizeUsername(account.username))
    const fate = classifyAccount(account, selection)
    if (fate === null) continue
    if ("target" in fate) targets.push(fate.target)
    else skipped.push(fate.skip)
  }

  for (const name of [...(selection.pinned ?? [])].sort((a, b) => a.localeCompare(b))) {
    if (!seenPinned.has(name)) {
      skipped.push({ id: null, username: name, email: null, role: null, reason: "NOT_SELECTED", detail: "no such account in this organization" })
    }
  }

  return { targets, skipped, sharedEmails }
}

/** Deterministic lines the digest is taken over: one per decision. */
export function forcedPasswordRotationPlanLines(plan: ForcedPasswordRotationPlan): string[] {
  const lines: string[] = []
  for (const target of plan.targets) {
    lines.push(`FLAG ${target.id} ${target.username ?? "-"} ${target.role} sv=${target.sessionVersion}${target.emailShared ? " shared-email" : ""}${target.emailUnroutable ? " unroutable-email" : ""}`)
  }
  for (const skip of plan.skipped) {
    lines.push(`SKIP ${skip.reason} ${skip.id ?? "-"} ${skip.username ?? "-"}`)
  }
  return lines
}

export interface ForcedPasswordRotationSummary {
  targets: number
  targetsByRole: Record<string, number>
  targetsWithSharedEmail: number
  skipped: number
  skippedByReason: Record<RotationSkipReason, number>
  sharedEmails: number
}

export function summarizeForcedPasswordRotation(plan: ForcedPasswordRotationPlan): ForcedPasswordRotationSummary {
  const targetsByRole: Record<string, number> = {}
  for (const target of plan.targets) targetsByRole[target.role] = (targetsByRole[target.role] ?? 0) + 1
  const skippedByReason: Record<RotationSkipReason, number> = {
    ALREADY_FLAGGED: 0, EMAIL_UNROUTABLE: 0, INACTIVE: 0, NOT_SELECTED: 0,
  }
  for (const skip of plan.skipped) skippedByReason[skip.reason] += 1
  return {
    targets: plan.targets.length,
    targetsByRole,
    targetsWithSharedEmail: plan.targets.filter((target) => target.emailShared).length,
    skipped: plan.skipped.length,
    skippedByReason,
    sharedEmails: plan.sharedEmails.length,
  }
}

// ============================================================
// Reversal
// ============================================================

export interface CommittedRotationTarget {
  id: string
  username: string | null
  sessionVersion: number
}

export type ReversalSkipReason = "NOT_FOUND" | "ALREADY_CLEARED" | "ROTATED" | "SESSION_MOVED"

export interface ReversalClear {
  id: string
  username: string | null
  /** The version the run left, which the clearing update is pinned to. */
  sessionVersion: number
}

export interface ReversalSkip {
  id: string
  username: string | null
  reason: ReversalSkipReason
  detail: string
}

export interface ForcedPasswordRotationReversal {
  clears: ReversalClear[]
  skipped: ReversalSkip[]
}

/**
 * Undo a committed run: clear the flag on every account it flagged, but only
 * where the account is exactly as the run left it. An account whose person
 * has since set a password stays as it is — they chose that password. The
 * version bump is never undone: lowering `session_version` would revalidate
 * tokens that were revoked, and a person re-signing in costs nothing.
 */
export function planForcedPasswordRotationReversal(
  committed: readonly CommittedRotationTarget[],
  current: readonly RotationAccount[],
): ForcedPasswordRotationReversal {
  const byId = new Map(current.map((account) => [account.id, account]))
  const clears: ReversalClear[] = []
  const skipped: ReversalSkip[] = []

  for (const target of [...committed].sort(byUsername)) {
    const account = byId.get(target.id)
    if (!account) {
      skipped.push({ id: target.id, username: target.username, reason: "NOT_FOUND", detail: "account no longer exists in this organization" })
      continue
    }
    if (account.passwordChangedAt !== null) {
      skipped.push({ id: target.id, username: target.username, reason: "ROTATED", detail: "the person has set a password; leaving it" })
      continue
    }
    if (!account.mustChangePassword) {
      skipped.push({ id: target.id, username: target.username, reason: "ALREADY_CLEARED", detail: "must_change_password is already clear" })
      continue
    }
    const expectedVersion = target.sessionVersion + 1
    if (account.sessionVersion !== expectedVersion) {
      skipped.push({
        id: target.id, username: target.username, reason: "SESSION_MOVED",
        detail: `session_version is ${account.sessionVersion}, expected ${expectedVersion}; something else touched this account`,
      })
      continue
    }
    clears.push({ id: target.id, username: target.username, sessionVersion: expectedVersion })
  }

  return { clears, skipped }
}

export function forcedPasswordRotationReversalLines(reversal: ForcedPasswordRotationReversal): string[] {
  return [
    ...reversal.clears.map((entry) => `CLEAR ${entry.id} ${entry.username ?? "-"} sv=${entry.sessionVersion}`),
    ...reversal.skipped.map((entry) => `SKIP ${entry.reason} ${entry.id} ${entry.username ?? "-"}`),
  ]
}

// ============================================================
// Status
// ============================================================

export interface RotationStatusRow {
  role: string
  pending: number
  completed: number
  unroutable: number
}

export interface RotationStatus {
  byRole: RotationStatusRow[]
  pendingUsernames: string[]
  unroutableUsernames: string[]
}

/**
 * Where a rotation stands: for each role in the population, how many
 * accounts still carry the flag, how many have set a password since `since`
 * (the run's commit time), and how many pending accounts could not receive a
 * code if they tried.
 */
function inPopulation(
  account: RotationAccount,
  options: Pick<RotationOptions, "roles" | "externalSources">,
): boolean {
  return account.isActive
    && options.roles.includes(account.role)
    && account.externalSource !== null
    && options.externalSources.includes(account.externalSource)
}

function completedSince(account: RotationAccount, since: Date): boolean {
  if (account.mustChangePassword || account.passwordChangedAt === null) return false
  return new Date(account.passwordChangedAt).getTime() >= since.getTime()
}

export function summarizeRotationStatus(
  accounts: readonly RotationAccount[],
  options: Pick<RotationOptions, "roles" | "externalSources">,
  since: Date,
): RotationStatus {
  const rows = new Map<string, RotationStatusRow>()
  const pendingUsernames: string[] = []
  const unroutableUsernames: string[] = []

  for (const account of [...accounts].sort(byUsername)) {
    if (!inPopulation(account, options)) continue
    const row = rows.get(account.role) ?? { role: account.role, pending: 0, completed: 0, unroutable: 0 }
    rows.set(account.role, row)

    if (completedSince(account, since)) {
      row.completed += 1
      continue
    }
    if (!account.mustChangePassword) continue

    row.pending += 1
    if (account.username) pendingUsernames.push(account.username)
    if (!isRoutableEmailAddress(account.email)) {
      row.unroutable += 1
      if (account.username) unroutableUsernames.push(account.username)
    }
  }

  return {
    byRole: [...rows.values()].sort((a, b) => a.role.localeCompare(b.role)),
    pendingUsernames,
    unroutableUsernames,
  }
}
