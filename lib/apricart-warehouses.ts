/**
 * Apricart's warehouses as places, in one place.
 *
 * A warehouse is the stable operational owner an order will be fulfilled by:
 * the people working it (`WAREHOUSE` operators and `APRICART_EXECUTIVE`
 * executives) are its members, and each customer branch may name one default
 * warehouse for its new orders (a route).
 *
 * **Mostly configuration.** The one thing membership decides: an order Super
 * Admin transferred to a warehouse is worked by its active operators
 * (`lib/order-warehouse-transfer.ts`). Otherwise a warehouse account still reaches the branches assigned to it
 * (`lib/warehouse-access.ts`) and an executive the organizations assigned to it
 * (`lib/apricart-executive-access.ts`). The coverage report below compares the
 * two models so Super Admin can map one onto the other before every order is
 * owned by a warehouse (phase 2). See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
 *
 * Pure, so the routes, the server module and the page read the same rules.
 */

import { APRICART_EXECUTIVE_ROLE } from "@/lib/apricart-executive-access"
import { WAREHOUSE_ROLE } from "@/lib/warehouse-access"

export const APRICART_WAREHOUSE_STATUSES = ["ACTIVE", "INACTIVE"] as const
export type ApricartWarehouseStatus = (typeof APRICART_WAREHOUSE_STATUSES)[number]

export const WAREHOUSE_RESPONSIBILITIES = ["WAREHOUSE_OPERATOR", "EXECUTIVE"] as const
export type WarehouseResponsibility = (typeof WAREHOUSE_RESPONSIBILITIES)[number]

export const WAREHOUSE_RESPONSIBILITY_LABELS: Record<WarehouseResponsibility, string> = {
  WAREHOUSE_OPERATOR: "Operator",
  EXECUTIVE: "Executive",
}

/**
 * Which of its warehouse's branches an operator works: all of them, or a
 * selection. An executive is always `ALL`. See plans/OF-WAREHOUSE-order-ownership-and-transfer.md (phase 2).
 */
export const WAREHOUSE_MEMBER_SCOPES = ["ALL", "SELECTED"] as const
export type WarehouseMemberScope = (typeof WAREHOUSE_MEMBER_SCOPES)[number]

export const WAREHOUSE_MEMBER_SCOPE_LABELS: Record<WarehouseMemberScope, string> = {
  ALL: "All branches",
  SELECTED: "Selected branches",
}

/** Audit actions, one per kind of change. */
export const CREATE_APRICART_WAREHOUSE_AUDIT_ACTION = "CREATE_APRICART_WAREHOUSE"
export const UPDATE_APRICART_WAREHOUSE_AUDIT_ACTION = "UPDATE_APRICART_WAREHOUSE"
export const UPDATE_APRICART_WAREHOUSE_MEMBERS_AUDIT_ACTION = "UPDATE_APRICART_WAREHOUSE_MEMBERS"
export const UPDATE_BRANCH_FULFILLMENT_ROUTES_AUDIT_ACTION = "UPDATE_BRANCH_FULFILLMENT_ROUTES"
export const UPDATE_WAREHOUSE_ROUTE_RULES_AUDIT_ACTION = "UPDATE_WAREHOUSE_ROUTE_RULES"
export const UPDATE_APRICART_WAREHOUSE_MEMBER_SCOPE_AUDIT_ACTION = "UPDATE_APRICART_WAREHOUSE_MEMBER_SCOPE"

/** Bounds: lists are capped, and one routing request names one organization's branches. */
export const APRICART_WAREHOUSE_MAX = 200
export const APRICART_WAREHOUSE_MEMBER_MAX = 200
export const BRANCH_ROUTE_MAX_PER_ORGANIZATION = 1000
/** Rules across every warehouse: one per organization and city is far below this. */
export const WAREHOUSE_ROUTE_RULE_MAX = 5000
/** How many open orders with no warehouse the page lists before it summarises. */
export const UNROUTED_ORDER_LIST_LIMIT = 50

export const APRICART_WAREHOUSE_CODE_MAX_LENGTH = 20
export const APRICART_WAREHOUSE_NAME_MAX_LENGTH = 150
export const APRICART_WAREHOUSE_CITY_MAX_LENGTH = 100
export const APRICART_WAREHOUSE_ADDRESS_MAX_LENGTH = 500
export const APRICART_WAREHOUSE_PHONE_MAX_LENGTH = 30

/**
 * A code is upper-case letters and digits, with single hyphens between them:
 * `KHI-01`, `LHR`. Upper-cased before it is checked, so `khi-01` is the same
 * code — the unique index sees one spelling.
 */
export const APRICART_WAREHOUSE_CODE_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/

export function normalizeWarehouseCode(raw: string): string {
  return raw.trim().toUpperCase()
}

/** A warehouse id from a path: a positive Postgres `integer`, or null (answered 404). */
export function parseWarehouseId(raw: string): number | null {
  if (!/^\d{1,10}$/.test(raw)) return null
  const value = Number(raw)
  return value > 0 && value <= 2_147_483_647 ? value : null
}

/** The responsibility an account holds in a warehouse follows from its role, or none can be held. */
export function responsibilityForRole(role: unknown): WarehouseResponsibility | null {
  if (role === WAREHOUSE_ROLE) return "WAREHOUSE_OPERATOR"
  if (role === APRICART_EXECUTIVE_ROLE) return "EXECUTIVE"
  return null
}

/** The roles whose accounts may be members of a warehouse. */
export const WAREHOUSE_MEMBER_ROLES: readonly string[] = [WAREHOUSE_ROLE, APRICART_EXECUTIVE_ROLE]

// ---------------------------------------------------------------------------
// Coverage: how today's account-based reach maps onto warehouses
// ---------------------------------------------------------------------------

export const BRANCH_COVERAGE_KINDS = ["ROUTED", "SUGGESTED", "AMBIGUOUS", "UNMAPPED", "UNSERVED"] as const
export type BranchCoverageKind = (typeof BRANCH_COVERAGE_KINDS)[number]

export const BRANCH_COVERAGE_LABELS: Record<BranchCoverageKind, string> = {
  ROUTED: "Routed",
  SUGGESTED: "Suggested",
  AMBIGUOUS: "Ambiguous",
  UNMAPPED: "No warehouse",
  UNSERVED: "Not served",
}

export type BranchCoverage = {
  kind: BranchCoverageKind
  /** The warehouse routed to, for `ROUTED`. */
  routeWarehouseId: number | null
  /**
   * For `ROUTED`: whether an account serving the branch today operates at the
   * routed warehouse. False means the people working the branch would change
   * if orders followed the route. Null when nobody serves it today.
   */
  routeMatchesReach: boolean | null
  /** For `SUGGESTED`: the one warehouse whose operators serve the branch today. */
  suggestedWarehouseId: number | null
  /** Every warehouse whose operators serve the branch today, ascending. */
  candidateWarehouseIds: number[]
}

/**
 * Classify one branch.
 *
 * `servingAccountIds` are the **active** warehouse accounts whose live reach
 * includes the branch; `operatorWarehouses` maps an account to the warehouses
 * it is an operator of. A route always wins; without one, the branch is
 * suggested only when the people serving it agree on exactly one warehouse —
 * never chosen among several.
 */
export function classifyBranchCoverage(input: {
  routeWarehouseId: number | null
  servingAccountIds: readonly string[]
  operatorWarehouses: ReadonlyMap<string, readonly number[]>
}): BranchCoverage {
  const candidates = new Set<number>()
  for (const accountId of input.servingAccountIds) {
    for (const warehouseId of input.operatorWarehouses.get(accountId) ?? []) candidates.add(warehouseId)
  }
  const candidateWarehouseIds = [...candidates].sort((a, b) => a - b)
  const none = { routeWarehouseId: null, routeMatchesReach: null, suggestedWarehouseId: null, candidateWarehouseIds }

  if (input.routeWarehouseId !== null) {
    return {
      ...none,
      kind: "ROUTED",
      routeWarehouseId: input.routeWarehouseId,
      routeMatchesReach: input.servingAccountIds.length === 0 ? null : candidates.has(input.routeWarehouseId),
    }
  }
  if (input.servingAccountIds.length === 0) return { ...none, kind: "UNSERVED" }
  if (candidateWarehouseIds.length === 0) return { ...none, kind: "UNMAPPED" }
  if (candidateWarehouseIds.length === 1) {
    return { ...none, kind: "SUGGESTED", suggestedWarehouseId: candidateWarehouseIds[0] }
  }
  return { ...none, kind: "AMBIGUOUS" }
}

/**
 * The organizations a warehouse is routed into that none of its executive
 * members may approve for — where an Order Desk order would have no executive
 * at that warehouse. Ascending, de-duplicated.
 */
export function executiveCoverageGaps(input: {
  routedOrganizationIds: readonly number[]
  executiveOrganizationIds: ReadonlyArray<readonly number[]>
}): number[] {
  const covered = new Set(input.executiveOrganizationIds.flat())
  return [...new Set(input.routedOrganizationIds)]
    .filter((organizationId) => !covered.has(organizationId))
    .sort((a, b) => a - b)
}

/** Counts per coverage kind, every kind present. */
export function summarizeCoverage(entries: ReadonlyArray<{ kind: BranchCoverageKind }>): Record<BranchCoverageKind, number> {
  const counts = Object.fromEntries(BRANCH_COVERAGE_KINDS.map((kind) => [kind, 0])) as Record<BranchCoverageKind, number>
  for (const entry of entries) counts[entry.kind] += 1
  return counts
}

// ---------------------------------------------------------------------------
// The page's views
// ---------------------------------------------------------------------------

/** The branches of one organization whose route names this warehouse, ascending. */
export function routedBranchIdsInOrganization(input: {
  routes: ReadonlyArray<{ branchId: number; warehouseId: number }>
  branchOrganization: ReadonlyMap<number, number>
  warehouseId: number
  organizationId: number
}): number[] {
  return input.routes
    .filter((route) => route.warehouseId === input.warehouseId
      && input.branchOrganization.get(route.branchId) === input.organizationId)
    .map((route) => route.branchId)
    .sort((a, b) => a - b)
}

/** The unrouted branches of one organization the coverage report suggests for this warehouse, ascending. */
export function suggestedBranchIdsFor(input: {
  coverage: ReadonlyArray<{ branchId: number; organizationId: number; kind: BranchCoverageKind; suggestedWarehouseId: number | null }>
  warehouseId: number
  organizationId: number
}): number[] {
  return input.coverage
    .filter((entry) => entry.kind === "SUGGESTED"
      && entry.suggestedWarehouseId === input.warehouseId
      && entry.organizationId === input.organizationId)
    .map((entry) => entry.branchId)
    .sort((a, b) => a - b)
}

/** Inactive warehouse accounts that still hold branch or city assignments: they serve nothing today. */
export function inactiveAccountsHoldingReach<T extends { isActive: boolean; branchIds: readonly number[]; cityKeys: readonly string[] }>(
  members: readonly T[],
): T[] {
  return members.filter((member) => !member.isActive && (member.branchIds.length > 0 || member.cityKeys.length > 0))
}

// ---------------------------------------------------------------------------
// Phase 2: a branch's warehouse, and moving accounts onto warehouses
// ---------------------------------------------------------------------------

/**
 * Which warehouse a branch is in: a manual route, else the rule for its
 * organization and city, else the rule for its organization, else none. The
 * pure statement of `branchWarehouseSql` (`lib/server/branch-warehouse.ts`),
 * which is the one the database evaluates; the two are tested against each other.
 */
export function resolveBranchWarehouse(input: {
  manualWarehouseId: number | null
  cityRuleWarehouseId: number | null
  organizationRuleWarehouseId: number | null
}): number | null {
  return input.manualWarehouseId ?? input.cityRuleWarehouseId ?? input.organizationRuleWarehouseId ?? null
}

export type WarehouseReachDifference = {
  accountId: string
  /** Branches the account reaches today and would not. */
  lost: number[]
  /** Branches it would reach and does not today. */
  gained: number[]
}

/**
 * Per account, what it would lose and gain going from one reach to another.
 * Only accounts with a difference are listed, in account order. An account
 * missing from either map reaches nothing there.
 */
export function compareWarehouseReach(
  current: ReadonlyMap<string, readonly number[]>,
  proposed: ReadonlyMap<string, readonly number[]>,
): WarehouseReachDifference[] {
  const accountIds = [...new Set([...current.keys(), ...proposed.keys()])].sort((a, b) => a.localeCompare(b))
  return accountIds.flatMap((accountId) => {
    const before = new Set(current.get(accountId) ?? [])
    const after = new Set(proposed.get(accountId) ?? [])
    const lost = [...before].filter((id) => !after.has(id)).sort((a, b) => a - b)
    const gained = [...after].filter((id) => !before.has(id)).sort((a, b) => a - b)
    return lost.length === 0 && gained.length === 0 ? [] : [{ accountId, lost, gained }]
  })
}

export type CityRuleMigrationAccount = {
  userId: string
  username: string
  isActive: boolean
  /** City keys assigned to the account, as stored (already normalised in SQL). */
  cityKeys: readonly string[]
  /** Organizations its cities apply to. */
  organizationIds: readonly number[]
  /** Branches assigned to it one by one. */
  branchIds: readonly number[]
}

export type CityRuleMigrationInput = {
  /** Every active, undeleted `WAREHOUSE` account, and any inactive one named in the mapping. */
  accounts: readonly CityRuleMigrationAccount[]
  /** Username -> warehouse id, as Super Admin named it. */
  mapping: ReadonlyArray<{ username: string; warehouseId: number }>
  warehouses: ReadonlyArray<{ id: number; code: string; status: string }>
  existingRules: ReadonlyArray<{ warehouseId: number; organizationId: number; cityKey: string | null }>
  existingRoutes: ReadonlyArray<{ branchId: number; warehouseId: number }>
  existingMemberships: ReadonlyArray<{ warehouseId: number; userId: string; responsibility: string; branchScope: string }>
}

export type CityRuleMigrationPlan = {
  rules: Array<{ warehouseId: number; organizationId: number; cityKey: string }>
  routes: Array<{ branchId: number; warehouseId: number }>
  memberships: Array<{ warehouseId: number; userId: string }>
  /** Reasons the plan cannot be applied. A plan with any is never written. */
  refusals: string[]
}

/**
 * Turn each mapped account's own reach into warehouse configuration that
 * reproduces it exactly: every (city, organization) pair it holds becomes an
 * organization-and-city rule on its warehouse, every single-branch assignment a
 * manual route, and the account an `ALL` operator of that warehouse.
 *
 * Refuses rather than guesses: an active account with assignments left
 * unmapped, a mapping to an unknown or inactive warehouse or account, two
 * accounts putting one (organization, city) or branch into different
 * warehouses, a rule or route already pointing elsewhere, or an existing
 * `SELECTED` membership (which would narrow what the account sees).
 * Idempotent: what already exists is not planned again.
 */
export function planCityRuleMigration(input: CityRuleMigrationInput): CityRuleMigrationPlan {
  const refusals: string[] = []
  const targetByUserId = resolveMappingTargets(input, refusals)
  refusals.push(...unmappedAccountRefusals(input.accounts, targetByUserId))
  refusals.push(...sharedWarehouseRefusals(input.accounts, targetByUserId))

  const accounts = [...input.accounts].sort((a, b) => a.username.localeCompare(b.username))
  const rules = planRules(accounts, targetByUserId, input.existingRules, refusals)
  const routes = planRoutes(accounts, targetByUserId, input.existingRoutes, refusals)
  const memberships = planMemberships(accounts, targetByUserId, input.existingMemberships, refusals)

  return { rules, routes, memberships, refusals: [...new Set(refusals)] }
}

/** Each mapped account's warehouse, refusing what the mapping names wrongly. */
function resolveMappingTargets(input: CityRuleMigrationInput, refusals: string[]): Map<string, number> {
  const warehouseById = new Map(input.warehouses.map((warehouse) => [warehouse.id, warehouse]))
  const accountByUsername = new Map(input.accounts.map((account) => [account.username, account]))
  const targetByUserId = new Map<string, number>()
  for (const entry of input.mapping) {
    const account = accountByUsername.get(entry.username)
    const warehouse = warehouseById.get(entry.warehouseId)
    if (!account) refusals.push(`No warehouse account has the username ${entry.username}`)
    else if (!account.isActive) refusals.push(`${entry.username} is inactive`)
    if (!warehouse) refusals.push(`Warehouse ${entry.warehouseId} does not exist`)
    else if (warehouse.status !== "ACTIVE") refusals.push(`Warehouse ${warehouse.code} is not active`)
    if (!account) continue
    const previous = targetByUserId.get(account.userId)
    if (previous !== undefined && previous !== entry.warehouseId) refusals.push(`${entry.username} is mapped to two warehouses`)
    targetByUserId.set(account.userId, entry.warehouseId)
  }
  return targetByUserId
}

/** What an account holds today: (organization, city) pairs and single branches. */
function accountReachKeys(account: CityRuleMigrationAccount): string {
  return [
    ...account.organizationIds.flatMap((organizationId) => account.cityKeys.map((cityKey) => `${organizationId}|${cityKey}`)),
    ...account.branchIds.map((branchId) => `#${branchId}`),
  ].sort((a, b) => a.localeCompare(b)).join(",")
}

/** An active account that serves branches must be mapped, or it would lose them. */
function unmappedAccountRefusals(accounts: readonly CityRuleMigrationAccount[], targets: ReadonlyMap<string, number>): string[] {
  return accounts
    .filter((account) => account.isActive && accountReachKeys(account) !== "" && !targets.has(account.userId))
    .map((account) => `${account.username} serves branches and is not mapped to a warehouse`)
}

/**
 * An operator works all of its warehouse's branches, so two accounts mapped to
 * one warehouse must hold the same reach today, or each would gain the other's.
 */
function sharedWarehouseRefusals(accounts: readonly CityRuleMigrationAccount[], targets: ReadonlyMap<string, number>): string[] {
  const refusals: string[] = []
  const firstOnWarehouse = new Map<number, CityRuleMigrationAccount>()
  for (const account of [...accounts].sort((a, b) => a.username.localeCompare(b.username))) {
    const warehouseId = targets.get(account.userId)
    if (warehouseId === undefined) continue
    const first = firstOnWarehouse.get(warehouseId)
    if (!first) firstOnWarehouse.set(warehouseId, account)
    else if (accountReachKeys(first) !== accountReachKeys(account)) {
      refusals.push(`${first.username} and ${account.username} are mapped to warehouse ${warehouseId} but serve different branches — each would gain the other's; map them to different warehouses`)
    }
  }
  return refusals
}

/** One organization-and-city rule per pair an account holds, on its warehouse. */
function planRules(
  accounts: readonly CityRuleMigrationAccount[],
  targets: ReadonlyMap<string, number>,
  existingRules: CityRuleMigrationInput["existingRules"],
  refusals: string[],
): CityRuleMigrationPlan["rules"] {
  const key = (organizationId: number, cityKey: string) => `${organizationId}\u0000${cityKey}`
  const existing = new Map(existingRules
    .filter((rule) => rule.cityKey !== null)
    .map((rule) => [key(rule.organizationId, rule.cityKey as string), rule.warehouseId]))
  const planned = new Map<string, { warehouseId: number; organizationId: number; cityKey: string; username: string }>()

  for (const account of accounts) {
    const warehouseId = targets.get(account.userId)
    if (warehouseId === undefined) continue
    const pairs = [...account.organizationIds].sort((a, b) => a - b)
      .flatMap((organizationId) => [...account.cityKeys].sort((a, b) => a.localeCompare(b)).map((cityKey) => ({ organizationId, cityKey })))
    for (const { organizationId, cityKey } of pairs) {
      const holder = existing.get(key(organizationId, cityKey))
      const already = planned.get(key(organizationId, cityKey))
      if (holder !== undefined && holder !== warehouseId) {
        refusals.push(`Organization ${organizationId} in ${cityKey} already belongs to warehouse ${holder}, not ${warehouseId}`)
      } else if (already && already.warehouseId !== warehouseId) {
        refusals.push(`${already.username} and ${account.username} put organization ${organizationId} in ${cityKey} into different warehouses`)
      } else if (holder === undefined && !already) {
        planned.set(key(organizationId, cityKey), { warehouseId, organizationId, cityKey, username: account.username })
      }
    }
  }
  return [...planned.values()]
    .map(({ warehouseId, organizationId, cityKey }) => ({ warehouseId, organizationId, cityKey }))
    .sort((a, b) => a.organizationId - b.organizationId || a.cityKey.localeCompare(b.cityKey))
}

/** One manual route per branch an account holds one by one, on its warehouse. */
function planRoutes(
  accounts: readonly CityRuleMigrationAccount[],
  targets: ReadonlyMap<string, number>,
  existingRoutes: CityRuleMigrationInput["existingRoutes"],
  refusals: string[],
): CityRuleMigrationPlan["routes"] {
  const existing = new Map(existingRoutes.map((route) => [route.branchId, route.warehouseId]))
  const planned = new Map<number, { warehouseId: number; username: string }>()
  for (const account of accounts) {
    const warehouseId = targets.get(account.userId)
    if (warehouseId === undefined) continue
    for (const branchId of [...account.branchIds].sort((a, b) => a - b)) {
      const holder = existing.get(branchId)
      const already = planned.get(branchId)
      if (holder !== undefined && holder !== warehouseId) {
        refusals.push(`Branch ${branchId} is already routed to warehouse ${holder}, not ${warehouseId}`)
      } else if (already && already.warehouseId !== warehouseId) {
        refusals.push(`${already.username} and ${account.username} put branch ${branchId} into different warehouses`)
      } else if (holder === undefined && !already) {
        planned.set(branchId, { warehouseId, username: account.username })
      }
    }
  }
  return [...planned.entries()]
    .map(([branchId, route]) => ({ branchId, warehouseId: route.warehouseId }))
    .sort((a, b) => a.branchId - b.branchId)
}

/** Each mapped account an all-branches operator of its warehouse; an existing narrower membership is refused. */
function planMemberships(
  accounts: readonly CityRuleMigrationAccount[],
  targets: ReadonlyMap<string, number>,
  existingMemberships: CityRuleMigrationInput["existingMemberships"],
  refusals: string[],
): CityRuleMigrationPlan["memberships"] {
  const memberships: CityRuleMigrationPlan["memberships"] = []
  for (const account of accounts) {
    const warehouseId = targets.get(account.userId)
    if (warehouseId === undefined) continue
    const membership = existingMemberships.find((row) => row.warehouseId === warehouseId && row.userId === account.userId)
    if (!membership) memberships.push({ warehouseId, userId: account.userId })
    else if (membership.responsibility !== "WAREHOUSE_OPERATOR") refusals.push(`${account.username} is not an operator of warehouse ${warehouseId}`)
    else if (membership.branchScope !== "ALL") refusals.push(`${account.username} works selected branches of warehouse ${warehouseId}; set it to all branches first`)
  }
  return memberships.sort((a, b) => a.warehouseId - b.warehouseId || a.userId.localeCompare(b.userId))
}
