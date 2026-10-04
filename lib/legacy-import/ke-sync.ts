/**
 * Repeatable K-Electric *reference data* sync from the legacy logistics API.
 *
 * `ke-orders-api.ts` already imports orders, but an order can only be written
 * once its branch, its ordering user and its products exist. Everything those
 * orders depend on had no sync path at all, so the orders quietly piled up
 * behind whatever was missing — on the day this module was written, ten orders
 * were held back by eight absent users and two absent branches, one of them
 * worth PKR 1.4 million. This module plans the entities the order import
 * depends on; the order import itself is unchanged.
 *
 * Everything here is pure. It takes legacy rows and current rows and returns a
 * plan, so the whole decision surface — which branch is which, who gets an
 * account, what gets renamed — is testable without a database or a network.
 * `scripts/sync-ke.ts` reads the rows, calls this, prints the plan, and only
 * writes when the operator hands the plan's digest back.
 *
 * Scope: organization 10 only. The organization is a constant here rather than
 * a parameter precisely so that no caller can point this at another tenant.
 * Note that organization 2 ("K-E-Demo") is a different record that shares many
 * of the same email addresses, and must never be touched by this sync.
 */

import { buildUsername, roleSuffix, slugToken } from "../username-generation"
import { canonicalJson, normalizeLegacyText, sha256 } from "./ke-post-cutoff"

export const KE_SYNC_ORGANIZATION = { id: 10, code: "0001", name: "K-Electric" } as const
export const KE_SYNC_SOURCE = "KE_LOGISTICS"

/** Role ids as seeded by `db:seed`; asserted against the database at run time. */
export const ROLE_BRANCH_ADMIN = "BRANCH_ADMIN"
export const ROLE_ORDER_PORTAL = "ORDER_PORTAL"

/**
 * Username suffixes that separate the two accounts a legacy person gets.
 *
 * The legacy platform gives one account both the ability to place an order and
 * the ability to approve it. OneFlowe keeps those apart, so each legacy person
 * becomes two accounts sharing an email and a password. The suffix is what the
 * person types to choose which portal they land in, so it has to be visible and
 * stable rather than inferred.
 */
export const SUFFIX_BRANCH_ADMIN = "-ba"
export const SUFFIX_ORDER_PORTAL = "-op"

/** The pre-existing convention this replaces: bare for approver, `_op` to order. */
const LEGACY_SUFFIX_ORDER_PORTAL = "_op"

/**
 * Accounts invented by earlier one-off imports to carry orders whose real
 * author was unknown. They are inactive, have `@historical.invalid` emails, and
 * are not people — they must never be renamed, paired, or counted as a person
 * already having an account.
 */
export const SYNTHETIC_EMAIL_DOMAIN = "@historical.invalid"

export function isSyntheticAccount(email: string | null | undefined): boolean {
  return String(email ?? "").toLowerCase().endsWith(SYNTHETIC_EMAIL_DOMAIN)
}

// ============================================================
// Source and target row shapes
// ============================================================

export interface LegacyLocation {
  ID: number
  Name: string
  StatusID: number | null
  Address?: string | null
  ContactNo?: string | null
  Email?: string | null
  MonthlyBudget?: number | null
}

export interface LegacyLocationGroup {
  ID: number
  Name: string
  IsActive?: boolean | null
  LocationIDs?: number[] | null
}

export interface LegacySubUser {
  ID: number
  UserName?: string | null
  FirstName?: string | null
  LastName?: string | null
  Email?: string | null
  ContactNo?: string | null
  /** The employee code. This, not `UserName`, is what OneFlowe usernames derive from. */
  Passcode?: string | number | null
  Password?: string | null
  LocationID?: number | null
  StatusID?: number | null
  UserType?: string | number | null
  SubuserLocations?: Array<{ LocationID?: number | null }> | null
}

export interface CurrentBranch {
  id: number
  name: string
  externalSource: string | null
  externalId: string | null
  groupId: number | null
}

export interface CurrentUser {
  id: string
  username: string | null
  email: string
  fullName: string | null
  /** Used to build `<first name>-<code>-<suffix>`; the full name is the fallback. */
  firstName?: string | null
  roleName: string
  branchId: number | null
  isActive: boolean
  externalSource: string | null
  externalId: string | null
}

export interface CurrentGroup {
  id: number
  name: string
}

// ============================================================
// Branch identity
// ============================================================

/**
 * Branches whose OneFlowe name drifted from the legacy name, confirmed against
 * order history and budget before being written down.
 *
 * These exist because matching on name is the only link the two systems had.
 * Legacy holds both `GSO` (id 15, never used: no orders, no users, no budget)
 * and `1. GSO` (id 44), while OneFlowe holds a single `GSO` carrying a
 * PKR 1,459,700 baseline budget and 33 imported orders — which is legacy 44's
 * budget and legacy 44's orders. Name similarity pointed at the wrong record;
 * the money and the order history point at the right one.
 *
 * Keyed by legacy location id, valued by the normalized OneFlowe branch name to
 * claim. Once claimed, the branch is pinned by id and renamed to the legacy
 * name, so this table stops being consulted and the drift cannot recur.
 */
export const BRANCH_NAME_OVERRIDES: ReadonlyMap<number, string> = new Map([
  [44, "gso"],
  [109, "liyari i"],
  [110, "baldia"],
])

export function normalizeName(value: unknown): string {
  return normalizeLegacyText(value).replace(/\s+/g, " ")
}

export type BranchPinSource = "EXTERNAL_ID" | "NAME_OVERRIDE" | "EXACT_NAME"

export interface BranchPin {
  legacyLocationId: number
  legacyName: string
  branchId: number
  currentName: string
  via: BranchPinSource
  /** True when the branch is not yet stamped with its legacy id. */
  needsPin: boolean
  /** Set when the OneFlowe name differs from the legacy name. */
  rename: { from: string; to: string } | null
}

export interface BranchCreate {
  legacyLocationId: number
  name: string
  address: string | null
  contactNo: string | null
  email: string | null
}

export interface BranchPlan {
  pins: BranchPin[]
  creates: BranchCreate[]
  /** OneFlowe branches with no legacy counterpart. Reported, never touched. */
  unmatched: CurrentBranch[]
  /** Legacy locations that could not be pinned unambiguously. */
  ambiguous: Array<{ legacyLocationId: number; legacyName: string; candidates: number[] }>
}

/**
 * Match legacy locations to OneFlowe branches, preferring evidence over names.
 *
 * The order is deliberate: a branch already stamped with its legacy id is
 * settled and never re-examined; a confirmed override comes next; only then
 * does an exact name match apply, and only when exactly one branch on each side
 * carries that name. Legacy has two locations named `Distribution Strategy` and
 * two named `Society Cluster`, so an unguarded name match would pair them
 * arbitrarily — both pairs are already pinned by id, which is why the ambiguity
 * never reaches the name step in practice, and why it must stay guarded anyway.
 */
export function planBranches(
  legacyLocations: readonly LegacyLocation[],
  currentBranches: readonly CurrentBranch[],
): BranchPlan {
  const pins: BranchPin[] = []
  const creates: BranchCreate[] = []
  const ambiguous: BranchPlan["ambiguous"] = []
  const claimed = new Set<number>()
  const pinnedLegacy = new Set<number>()

  const byLegacyId = new Map<number, LegacyLocation>()
  for (const location of legacyLocations) byLegacyId.set(location.ID, location)

  function pin(location: LegacyLocation, branch: CurrentBranch, via: BranchPinSource) {
    claimed.add(branch.id)
    pinnedLegacy.add(location.ID)
    pins.push({
      legacyLocationId: location.ID,
      legacyName: location.Name,
      branchId: branch.id,
      currentName: branch.name,
      via,
      needsPin: branch.externalSource !== KE_SYNC_SOURCE || branch.externalId !== String(location.ID),
      rename: branch.name === location.Name ? null : { from: branch.name, to: location.Name },
    })
  }

  // 1. Already stamped with a legacy id — settled, whatever the names say.
  for (const branch of currentBranches) {
    if (branch.externalSource !== KE_SYNC_SOURCE || !branch.externalId) continue
    const location = byLegacyId.get(Number(branch.externalId))
    if (!location) continue
    pin(location, branch, "EXTERNAL_ID")
  }

  // 2. Confirmed name overrides.
  for (const [legacyLocationId, targetName] of BRANCH_NAME_OVERRIDES) {
    if (pinnedLegacy.has(legacyLocationId)) continue
    const location = byLegacyId.get(legacyLocationId)
    if (!location) continue
    const candidates = currentBranches.filter(
      (branch) => !claimed.has(branch.id) && normalizeName(branch.name) === targetName,
    )
    if (candidates.length === 1) pin(location, candidates[0], "NAME_OVERRIDE")
    else if (candidates.length > 1) {
      ambiguous.push({
        legacyLocationId,
        legacyName: location.Name,
        candidates: candidates.map((branch) => branch.id),
      })
      pinnedLegacy.add(legacyLocationId)
    }
  }

  // 3. Name matching, in two passes.
  //
  //    The exact pass runs first because normalization strips punctuation, and
  //    punctuation is sometimes the whole name: legacy holds both `Johar |` and
  //    `Johar ||`, which normalize to the same string but are plainly different
  //    branches and match their OneFlowe counterparts character for character.
  //    Normalizing first would call that pair ambiguous and stall the sync.
  //    Each pass requires exactly one unclaimed candidate on each side.
  for (const key of [(value: string) => value.trim(), normalizeName]) {
    for (const location of legacyLocations) {
      if (pinnedLegacy.has(location.ID)) continue
      const wanted = key(location.Name)
      const legacyWithName = legacyLocations.filter(
        (other) => !pinnedLegacy.has(other.ID) && key(other.Name) === wanted,
      )
      const candidates = currentBranches.filter(
        (branch) => !claimed.has(branch.id) && key(branch.name) === wanted,
      )
      if (candidates.length === 1 && legacyWithName.length === 1) {
        pin(location, candidates[0], "EXACT_NAME")
      }
    }
  }

  // 4. Anything still unpinned that a name points at more than one way is
  //    reported rather than guessed.
  for (const location of legacyLocations) {
    if (pinnedLegacy.has(location.ID)) continue
    const candidates = currentBranches.filter(
      (branch) => !claimed.has(branch.id) && normalizeName(branch.name) === normalizeName(location.Name),
    )
    if (candidates.length === 0) continue
    ambiguous.push({
      legacyLocationId: location.ID,
      legacyName: location.Name,
      candidates: candidates.map((branch) => branch.id),
    })
    pinnedLegacy.add(location.ID)
  }

  // 5. Whatever legacy still holds that OneFlowe does not.
  for (const location of legacyLocations) {
    if (pinnedLegacy.has(location.ID)) continue
    creates.push({
      legacyLocationId: location.ID,
      name: location.Name,
      address: location.Address?.trim() || null,
      contactNo: location.ContactNo?.trim() || null,
      email: location.Email?.trim() || null,
    })
  }

  return {
    pins: pins.toSorted((a, b) => a.legacyLocationId - b.legacyLocationId),
    creates: creates.toSorted((a, b) => a.legacyLocationId - b.legacyLocationId),
    unmatched: currentBranches.filter((branch) => !claimed.has(branch.id)),
    ambiguous,
  }
}

// ============================================================
// Group membership
// ============================================================

export interface GroupAssignment {
  branchId: number
  branchName: string
  groupId: number
  groupName: string
  fromGroupId: number | null
}

export interface GroupPlan {
  assignments: GroupAssignment[]
  /** Legacy groups with no OneFlowe counterpart. Reported, never created. */
  missingGroups: string[]
}

/**
 * Re-apply legacy group membership to pinned branches.
 *
 * Groups themselves are not created here. All four already exist, and a group
 * in OneFlowe carries pricing scope — creating one is a pricing decision, not a
 * sync decision (see `lib/pricing-access.ts`). A legacy group with no
 * counterpart is therefore reported for a human, not invented.
 */
export function planGroups(
  legacyGroups: readonly LegacyLocationGroup[],
  currentGroups: readonly CurrentGroup[],
  pins: readonly BranchPin[],
  currentBranches: readonly CurrentBranch[],
): GroupPlan {
  const groupByName = new Map(currentGroups.map((group) => [normalizeName(group.name), group]))
  const branchByLegacyId = new Map(pins.map((pin) => [pin.legacyLocationId, pin]))
  const currentById = new Map(currentBranches.map((branch) => [branch.id, branch]))
  const assignments: GroupAssignment[] = []
  const missingGroups: string[] = []

  for (const legacyGroup of legacyGroups) {
    const group = groupByName.get(normalizeName(legacyGroup.Name))
    if (!group) {
      missingGroups.push(legacyGroup.Name)
      continue
    }
    for (const locationId of legacyGroup.LocationIDs ?? []) {
      const pin = branchByLegacyId.get(Number(locationId))
      if (!pin) continue
      const branch = currentById.get(pin.branchId)
      if (branch?.groupId === group.id) continue
      assignments.push({
        branchId: pin.branchId,
        branchName: pin.legacyName,
        groupId: group.id,
        groupName: group.name,
        fromGroupId: branch?.groupId ?? null,
      })
    }
  }
  return { assignments, missingGroups }
}

// ============================================================
// Username convention
// ============================================================

export interface UsernameRename {
  userId: string
  from: string
  to: string
  roleName: string
}

/**
 * The username shape every K-Electric portal account carries today:
 * `<first name>-<employee code>-<ba|op>`, as `lib/username-generation.ts`
 * builds it and as the credential hand-out spells it. An account already in
 * this shape is never renamed by the sync — it is what the person was told.
 */
const NAMED_USERNAME = /^([a-z0-9]+)-([a-z0-9]+)-(ba|op)$/i

export function isNamedUsername(username: string | null | undefined): boolean {
  return NAMED_USERNAME.test(String(username ?? "").trim())
}

/**
 * The username for one account under the current convention.
 *
 * Falls back to the bare `<code>-<suffix>` form only when no first name is
 * known at all, so a person legacy records with an empty name still gets an
 * account rather than being skipped.
 */
export function accountUsername(
  firstName: string | null | undefined,
  employeeCode: string,
  roleName: string,
): string {
  const built = buildUsername(firstName, employeeCode, roleName)
  if ("username" in built) return built.username
  const suffix = roleSuffix(roleName) ?? SUFFIX_BRANCH_ADMIN.slice(1)
  return `${slugToken(employeeCode) || employeeCode}-${suffix}`
}

/** The first name a username should be built from, from whichever field holds one. */
export function firstNameOf(user: Pick<CurrentUser, "firstName" | "fullName">): string | null {
  const first = String(user.firstName ?? "").trim()
  if (first) return first
  const full = String(user.fullName ?? "").trim()
  return full ? full.split(/\s+/)[0] : null
}

/**
 * Move existing accounts onto the current username convention.
 *
 * Historically an approver held the bare employee code and the order-portal
 * account held `<code>_op`; a first pass added an explicit `-ba` / `-op`
 * suffix, and a later regeneration prefixed the person's first name. Accounts
 * still on either older form are brought forward; anything already in the
 * named shape is left exactly as it is.
 *
 * Only the two portal roles are renamed — a head-office account has no suffix
 * convention. Synthetic historical accounts are excluded: they are inactive
 * placeholders that nobody signs in as, and renaming them would only churn
 * rows that exist to hold order attribution.
 */
export function planUsernameMigration(currentUsers: readonly CurrentUser[]): {
  renames: UsernameRename[]
  collisions: Array<{ to: string; userIds: string[] }>
} {
  const renames: UsernameRename[] = []
  for (const user of currentUsers) {
    if (!user.username || isSyntheticAccount(user.email)) continue
    if (user.roleName !== ROLE_BRANCH_ADMIN && user.roleName !== ROLE_ORDER_PORTAL) continue
    if (isNamedUsername(user.username)) continue
    const suffix = user.roleName === ROLE_ORDER_PORTAL ? SUFFIX_ORDER_PORTAL : SUFFIX_BRANCH_ADMIN
    const base = user.username.endsWith(LEGACY_SUFFIX_ORDER_PORTAL)
      ? user.username.slice(0, -LEGACY_SUFFIX_ORDER_PORTAL.length)
      : user.username.replace(/(-ba|-op)$/i, "")
    const firstName = firstNameOf(user)
    const to = firstName ? accountUsername(firstName, base, user.roleName) : `${base}${suffix}`
    if (to === user.username) continue
    renames.push({ userId: user.id, from: user.username, to, roleName: user.roleName })
  }

  const seen = new Map<string, string[]>()
  const untouched = new Set(
    currentUsers
      .filter((user) => user.username && !renames.some((rename) => rename.userId === user.id))
      .map((user) => user.username as string),
  )
  for (const rename of renames) {
    if (!seen.has(rename.to)) seen.set(rename.to, [])
    seen.get(rename.to)!.push(rename.userId)
  }
  const collisions: Array<{ to: string; userIds: string[] }> = []
  for (const [to, userIds] of seen) {
    if (userIds.length > 1 || untouched.has(to)) collisions.push({ to, userIds })
  }
  return { renames, collisions }
}

// ============================================================
// User accounts
// ============================================================

export type UserSkipReason =
  | "NO_PASSCODE"
  | "NO_PASSWORD"
  | "NO_LOCATION"
  | "BRANCH_NOT_PINNED"
  | "USERNAME_TAKEN"
  | "INACTIVE_IN_LEGACY"

export interface PlannedAccount {
  roleName: typeof ROLE_BRANCH_ADMIN | typeof ROLE_ORDER_PORTAL
  username: string
}

/**
 * A legacy employee code that OneFlowe already has on somebody else.
 *
 * Seven of these exist. In six the OneFlowe holder is not in the legacy system
 * at all — they were added straight to OneFlowe by an earlier spreadsheet
 * import, which gave them a code K-Electric had already issued to someone else.
 * In the seventh the holder *is* in legacy, under a different code. Either way
 * one of the two systems is wrong about who owns the code, and this module is
 * not entitled to decide which: it creates the legacy person under a derived
 * identity so their orders can be attributed, leaves the sitting account
 * untouched, and reports the clash for K-Electric to settle.
 */
export interface EmployeeCodeConflict {
  legacySubUserId: number
  employeeCode: string
  legacyName: string
  legacyEmail: string | null
  heldByUserId: string
  heldByName: string | null
  heldByEmail: string
  assignedIdentity: string
}

/** The identity given to a person whose employee code is held by someone else. */
export function contestedIdentityFor(legacySubUserId: number): string {
  return `ke${legacySubUserId}`
}

/**
 * Domain for people the legacy system holds no email address for.
 *
 * `.invalid` is reserved by RFC 2606 and can never be routed, which is the
 * point: a plausible-looking address on a real domain would eventually be
 * mailed by the order notification outbox, and would then deliver K-Electric's
 * internal order traffic to whichever stranger owns that mailbox.
 */
export const DERIVED_EMAIL_DOMAIN = "ke-legacy.invalid"

export function fallbackEmail(subUser: LegacySubUser): string {
  const slug = normalizeLegacyText(personName(subUser) || `user ${subUser.ID}`)
    .split(" ")
    .filter(Boolean)
    .join(".")
  return `${slug || `user.${subUser.ID}`}@${DERIVED_EMAIL_DOMAIN}`
}

/**
 * Whether a OneFlowe account belongs to the legacy person holding a code.
 *
 * Either the email or the name agreeing is enough, because both fields drift
 * independently: legacy writes "Malaika Fayyaz Khan -", doubles several names
 * outright, and carries one person as `ramsha.javaid@ke.com` where OneFlowe has
 * `ramsha.javaid@ke.com.pk`. Requiring both to agree would call that pair two
 * people and duplicate her. Only when the name *and* the address both disagree
 * is the code genuinely on somebody else — which is the case for the seven
 * clashes this distinguishes.
 */
export function isSamePerson(subUser: LegacySubUser, account: CurrentUser): boolean {
  if (isSyntheticAccount(account.email)) return false
  const legacyEmail = normalizeLegacyText(subUser.Email)
  const accountEmail = normalizeLegacyText(account.email)
  if (legacyEmail && accountEmail && legacyEmail === accountEmail) return true
  const legacyName = normalizeName(personName(subUser))
  const accountName = normalizeName(account.fullName)
  if (!legacyName || !accountName) return !legacyEmail || !accountEmail
  return accountName.includes(legacyName) || legacyName.includes(accountName)
}

export interface PlannedPerson {
  legacySubUserId: number
  email: string
  /** True when no address existed in legacy and one was derived. */
  emailIsDerived: boolean
  fullName: string
  firstName: string | null
  lastName: string | null
  phone: string | null
  employeeCode: string
  branchId: number
  branchName: string
  /** Mirrored from legacy so the first sign-in works; retired on that sign-in. */
  legacyPassword: string
  accounts: PlannedAccount[]
}

export interface SkippedPerson {
  legacySubUserId: number
  email: string | null
  reason: UserSkipReason
  detail: string
}

export interface UserPlan {
  people: PlannedPerson[]
  skipped: SkippedPerson[]
  /** Legacy people who already hold accounts. */
  alreadyPresent: number
  /** Accounts a present person is missing — e.g. an approver with no order-portal twin. */
  backfill: Array<{
    legacySubUserId: number
    email: string
    username: string
    roleName: string
    branchId: number
    /** The existing account whose credentials the new twin copies. */
    sourceUserId: string
  }>
  /**
   * Existing accounts to stamp with their external identity.
   *
   * The stamp is what makes an account mirrored rather than native, and only
   * native accounts may sign in with an email address. Every account that came
   * from the legacy platform therefore has to carry it, including the 268 that
   * predate the column — otherwise those people would keep the ambiguous
   * email login this convention exists to remove.
   */
  stamps: Array<{ userId: string; username: string; externalId: string }>
  /** Employee codes OneFlowe has on a different person than legacy does. */
  conflicts: EmployeeCodeConflict[]
  /**
   * Accounts sitting at a different branch than legacy assigns them to.
   *
   * Only reachable because `LocationID` was trusted over `SubuserLocations`
   * before `legacyLocationOf` existed; a person put at the wrong branch takes
   * their branch's orders with them, and leaves the right branch looking
   * unstaffed. Moving them is a correction toward the source, not a
   * preference — legacy is the record of who works where.
   */
  branchMoves: BranchMove[]
}

export interface BranchMove {
  userId: string
  username: string
  fromBranchId: number
  toBranchId: number
  toBranchName: string
  legacySubUserId: number
}

/**
 * The identity a mirrored account is keyed by: the employee code.
 *
 * Not the legacy sub-user id, though that would be the obvious choice. Accounts
 * created by earlier imports never recorded one, and back-filling it would mean
 * guessing which legacy person each of the existing 268 accounts belongs to.
 * The employee code is already carried by both systems — it is the legacy
 * `Passcode`, and it is the stem of every OneFlowe username here — it is unique
 * across all 148 legacy people, and it survives a person moving branch.
 */
export function employeeCodeOf(username: string | null | undefined): string | null {
  const name = String(username ?? "").trim()
  if (!name) return null
  // `<first name>-<code>-<suffix>`: the code is the middle segment.
  const named = NAMED_USERNAME.exec(name)
  if (named) return named[2]
  const stem = name.replace(/(-ba|-op|_op)$/i, "")
  return stem && stem !== name ? stem : (/^[A-Za-z0-9._-]+$/.test(name) ? name : null)
}

/**
 * The legacy location a person actually works at.
 *
 * `LocationID` looks like the answer and is not: it is a default that legacy
 * populates for everyone, overwhelmingly with 2 (KE HOUSE). The real assignment
 * is `SubuserLocations`, and for thirteen of the 148 people the two disagree —
 * Kashif Memon (passcode 16592) carries LocationID 2 while his
 * SubuserLocations says GSMP-KKI, which is where K-Electric's own user report
 * places him and where his orders were raised.
 *
 * So `LocationID` is honoured only when `SubuserLocations` agrees that the
 * person is there; otherwise the explicit assignment wins. Preferring
 * SubuserLocations outright would also be correct today, but this keeps the
 * one person who holds several locations on the branch legacy names first.
 */
export function legacyLocationOf(subUser: LegacySubUser): number | null {
  const assigned = (subUser.SubuserLocations ?? [])
    .map((entry) => Number(entry?.LocationID))
    .filter((id) => Number.isInteger(id) && id > 0)
  const home = subUser.LocationID == null ? null : Number(subUser.LocationID)

  if (assigned.length === 0) return home
  if (home != null && assigned.includes(home)) return home
  return assigned[0]
}

function personName(subUser: LegacySubUser): string {
  const first = String(subUser.FirstName ?? "").trim()
  const last = String(subUser.LastName ?? "").trim()
  // Legacy stores a doubled name for several people ("Adnan Siddiqui Adnan
  // Siddiqui"); collapse it rather than carry it into the new system.
  if (first && last && normalizeName(first) === normalizeName(last)) return first
  if (first && last && normalizeName(first).endsWith(normalizeName(last))) return first
  return [first, last].filter(Boolean).join(" ").trim()
}

/**
 * Plan one pair of accounts per legacy person who does not already have them.
 *
 * A person is identified by their legacy sub-user id, never by name or email:
 * twelve K-Electric emails are shared by more than one person, and names are
 * entered inconsistently. Where a person already holds accounts, only the
 * missing half is backfilled.
 */
export function planUsers(
  legacySubUsers: readonly LegacySubUser[],
  pins: readonly BranchPin[],
  currentUsers: readonly CurrentUser[],
  options: {
    renames?: readonly UsernameRename[]
    /**
     * Usernames held anywhere in the table — other tenants and soft-deleted
     * rows included. `users_username_idx` is unique across the whole table,
     * so a name held by a deleted row is still not free.
     */
    takenUsernames?: Iterable<string>
  } = {},
): UserPlan {
  const branchByLegacyId = new Map(pins.map((pin) => [pin.legacyLocationId, pin]))
  const people: PlannedPerson[] = []
  const skipped: SkippedPerson[] = []
  const backfill: UserPlan["backfill"] = []
  const stamps: UserPlan["stamps"] = []
  const branchMoves: BranchMove[] = []
  const conflicts: EmployeeCodeConflict[] = []
  let alreadyPresent = 0

  // Usernames after the migration in `planUsernameMigration` has been applied,
  // so a new account cannot be planned onto a name that is about to be taken.
  const renameById = new Map((options.renames ?? []).map((rename) => [rename.userId, rename.to]))
  const takenUsernames = new Set<string>()
  for (const name of options.takenUsernames ?? []) {
    if (name) takenUsernames.add(String(name).toLowerCase())
  }
  for (const user of currentUsers) {
    const name = renameById.get(user.id) ?? user.username
    if (name) takenUsernames.add(name.toLowerCase())
  }

  // Existing accounts by legacy identity first — `external_id` carries the
  // employee code — then by the code in the username, so accounts created
  // before `external_id` existed are still recognised as that person's.
  const byExternalId = new Map<string, CurrentUser[]>()
  const byEmployeeCode = new Map<string, CurrentUser[]>()
  for (const user of currentUsers) {
    if (isSyntheticAccount(user.email)) continue
    if (user.externalSource === KE_SYNC_SOURCE && user.externalId) {
      const list = byExternalId.get(user.externalId.toLowerCase()) ?? []
      list.push(user)
      byExternalId.set(user.externalId.toLowerCase(), list)
    }
    const name = renameById.get(user.id) ?? user.username
    const code = employeeCodeOf(name)
    if (!code) continue
    const list = byEmployeeCode.get(code.toLowerCase()) ?? []
    list.push(user)
    byEmployeeCode.set(code.toLowerCase(), list)
    if (!user.externalSource) {
      stamps.push({ userId: user.id, username: name as string, externalId: code })
    }
  }

  for (const subUser of legacySubUsers) {
    const legacySubUserId = Number(subUser.ID)
    const email = String(subUser.Email ?? "").trim()
    const passcode = String(subUser.Passcode ?? "").trim()
    const skip = (reason: UserSkipReason, detail: string) =>
      skipped.push({ legacySubUserId, email: email || null, reason, detail })

    if (!passcode) {
      skip("NO_PASSCODE", "legacy record has no employee code to build a username from")
      continue
    }
    // An account already created for this person under a contested code keeps
    // its own identity, so a re-run recognises it before the code is consulted.
    const contestedId = contestedIdentityFor(legacySubUserId)
    const holdersOfCode = [...new Map(
      [
        ...(byExternalId.get(passcode.toLowerCase()) ?? []),
        ...(byEmployeeCode.get(passcode.toLowerCase()) ?? []),
      ].map((account) => [account.id, account]),
    ).values()]
    const ownAccounts = byExternalId.get(contestedId.toLowerCase()) ?? []
    const sameHolders = holdersOfCode.filter((account) => isSamePerson(subUser, account))
    const existing = ownAccounts.length > 0 ? ownAccounts : sameHolders
    // The code is held, but by somebody else: K-Electric's own list says this
    // code belongs to the legacy person, while OneFlowe has it on an account
    // with a different name and a different email. Neither record can be
    // overwritten from here — one of them is wrong and only K-Electric can say
    // which — so this person is created under an identity derived from their
    // legacy record instead, and the clash is reported.
    const contested = existing.length === 0 && holdersOfCode.length > 0
    const identity = contested ? contestedId : passcode

    // Resolved before the already-present branch as well as after it: an
    // account that already exists still has to be checked against the branch
    // legacy assigns it to.
    const locationId = legacyLocationOf(subUser)
    const pin = locationId == null ? undefined : branchByLegacyId.get(Number(locationId))

    if (existing.length > 0) {
      alreadyPresent += 1
      const roles = new Set(existing.map((user) => user.roleName))
      const branchId = existing.find((user) => user.branchId != null)?.branchId ?? null
      for (const account of pin ? existing : []) {
        if (account.branchId != null && account.branchId !== pin!.branchId) {
          branchMoves.push({
            userId: account.id,
            username: account.username ?? "",
            fromBranchId: account.branchId,
            toBranchId: pin!.branchId,
            toBranchName: pin!.currentName,
            legacySubUserId,
          })
        }
      }
      // The twin copies its sibling's credentials, so a portal account is the
      // preferred source; a head-office account may carry a different password.
      const source = existing.find((user) => user.roleName === ROLE_BRANCH_ADMIN || user.roleName === ROLE_ORDER_PORTAL)
        ?? existing[0]
      const sourceName = renameById.get(source.id) ?? source.username
      // The stamp is the identity; the username is only consulted for an
      // account that predates the stamp.
      const code = (source.externalSource === KE_SYNC_SOURCE && source.externalId)
        || employeeCodeOf(sourceName) || passcode
      for (const roleName of [ROLE_BRANCH_ADMIN, ROLE_ORDER_PORTAL] as const) {
        if (roles.has(roleName) || branchId == null) continue
        // Mirror the sibling's shape: swap the suffix on a named username, and
        // build a named one from scratch when the sibling has no suffix at all.
        const username = isNamedUsername(sourceName)
          ? String(sourceName).replace(/-(ba|op)$/i, `-${roleSuffix(roleName)}`)
          : accountUsername(firstNameOf(source) ?? String(subUser.FirstName ?? "").trim(), code, roleName)
        if (takenUsernames.has(username.toLowerCase())) continue
        takenUsernames.add(username.toLowerCase())
        backfill.push({
          legacySubUserId,
          email: source.email,
          username,
          roleName,
          branchId,
          sourceUserId: source.id,
        })
      }
      continue
    }

    if (contested) {
      conflicts.push({
        legacySubUserId,
        employeeCode: passcode,
        legacyName: personName(subUser) || String(subUser.Email ?? ""),
        legacyEmail: email || null,
        heldByUserId: holdersOfCode[0].id,
        heldByName: holdersOfCode[0].fullName,
        heldByEmail: holdersOfCode[0].email,
        assignedIdentity: contestedId,
      })
    }
    const password = String(subUser.Password ?? "")
    if (!password) {
      skip("NO_PASSWORD", "legacy record has no password to mirror for the first sign-in")
      continue
    }
    const resolvedEmail = email || fallbackEmail(subUser)
    if (locationId == null) {
      skip("NO_LOCATION", "legacy record is not attached to any location")
      continue
    }
    if (!pin) {
      skip("BRANCH_NOT_PINNED", `legacy location ${locationId} has no OneFlowe branch yet`)
      continue
    }

    const accounts: PlannedAccount[] = []
    let clash = false
    for (const roleName of [ROLE_BRANCH_ADMIN, ROLE_ORDER_PORTAL] as const) {
      const username = accountUsername(String(subUser.FirstName ?? "").trim(), identity, roleName)
      if (takenUsernames.has(username.toLowerCase())) {
        skip("USERNAME_TAKEN", `username "${username}" already belongs to another account`)
        clash = true
        break
      }
      accounts.push({ roleName, username })
    }
    if (clash) continue
    for (const account of accounts) takenUsernames.add(account.username.toLowerCase())

    people.push({
      legacySubUserId,
      email: resolvedEmail,
      emailIsDerived: !email,
      fullName: personName(subUser) || resolvedEmail,
      firstName: String(subUser.FirstName ?? "").trim() || null,
      lastName: String(subUser.LastName ?? "").trim() || null,
      phone: String(subUser.ContactNo ?? "").trim() || null,
      employeeCode: identity,
      branchId: pin.branchId,
      branchName: pin.legacyName,
      legacyPassword: password,
      accounts,
    })
  }

  return { people, skipped, alreadyPresent, backfill, stamps, conflicts, branchMoves }
}

// ============================================================
// Plan digest
// ============================================================

export interface SyncPlan {
  branches: BranchPlan
  groups: GroupPlan
  usernames: ReturnType<typeof planUsernameMigration>
  users: UserPlan
}

export interface SyncCounts {
  branchesToPin: number
  branchesToRename: number
  branchesToCreate: number
  branchesUnmatched: number
  branchesAmbiguous: number
  groupAssignments: number
  usernameRenames: number
  peopleToCreate: number
  accountsToCreate: number
  accountsToBackfill: number
  accountsToStamp: number
  peopleSkipped: number
  peopleAlreadyPresent: number
  /** Accounts sitting at a branch legacy does not assign them to. */
  branchMoves: number
  employeeCodeConflicts: number
  derivedEmails: number
}

export function summarize(plan: SyncPlan): SyncCounts {
  return {
    branchesToPin: plan.branches.pins.filter((pin) => pin.needsPin).length,
    branchesToRename: plan.branches.pins.filter((pin) => pin.rename).length,
    branchesToCreate: plan.branches.creates.length,
    branchesUnmatched: plan.branches.unmatched.length,
    branchesAmbiguous: plan.branches.ambiguous.length,
    groupAssignments: plan.groups.assignments.length,
    usernameRenames: plan.usernames.renames.length,
    peopleToCreate: plan.users.people.length,
    accountsToCreate: plan.users.people.reduce((total, person) => total + person.accounts.length, 0),
    accountsToBackfill: plan.users.backfill.length,
    accountsToStamp: plan.users.stamps.length,
    peopleSkipped: plan.users.skipped.length,
    peopleAlreadyPresent: plan.users.alreadyPresent,
    branchMoves: plan.users.branchMoves.length,
    employeeCodeConflicts: plan.users.conflicts.length,
    derivedEmails: plan.users.people.filter((person) => person.emailIsDerived).length,
  }
}

/**
 * A digest of everything the plan would change, and nothing else.
 *
 * Passwords are deliberately excluded: the digest is printed to a terminal and
 * written to a report file, and a hash that changes with a password would leak
 * whether a password changed. Reported counts and identities are enough to
 * detect that the source moved between the dry run and the commit.
 */
export function planDigest(plan: SyncPlan): string {
  return sha256(canonicalJson({
    organization: KE_SYNC_ORGANIZATION.id,
    source: KE_SYNC_SOURCE,
    pins: plan.branches.pins
      .filter((pin) => pin.needsPin || pin.rename)
      .map((pin) => [pin.legacyLocationId, pin.branchId, pin.rename?.to ?? null]),
    creates: plan.branches.creates.map((create) => [create.legacyLocationId, create.name]),
    groups: plan.groups.assignments.map((assignment) => [assignment.branchId, assignment.groupId]),
    usernames: plan.usernames.renames.map((rename) => [rename.userId, rename.to]),
    people: plan.users.people.map((person) => [
      person.legacySubUserId,
      person.email,
      person.branchId,
      person.accounts.map((account) => account.username),
    ]),
    backfill: plan.users.backfill.map((entry) => [entry.legacySubUserId, entry.username]),
    stamps: plan.users.stamps.map((stamp) => [stamp.userId, stamp.externalId]),
    conflicts: plan.users.conflicts.map((c) => [c.legacySubUserId, c.employeeCode, c.assignedIdentity]),
  }))
}
