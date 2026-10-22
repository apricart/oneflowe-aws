/**
 * Apricart's warehouses as places, in one place.
 *
 * A warehouse is the stable operational owner an order will be fulfilled by:
 * the people working it (`WAREHOUSE` operators and `APRICART_EXECUTIVE`
 * executives) are its members, and each customer branch may name one default
 * warehouse for its new orders (a route).
 *
 * **Configuration only, for now.** Nothing here decides what anyone may see or
 * do: a warehouse account still reaches the branches assigned to it
 * (`lib/warehouse-access.ts`) and an executive the organizations assigned to it
 * (`lib/apricart-executive-access.ts`). The coverage report below compares the
 * two models so Super Admin can map one onto the other before orders are ever
 * owned by a warehouse. See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
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

/** Audit actions, one per kind of change. */
export const CREATE_APRICART_WAREHOUSE_AUDIT_ACTION = "CREATE_APRICART_WAREHOUSE"
export const UPDATE_APRICART_WAREHOUSE_AUDIT_ACTION = "UPDATE_APRICART_WAREHOUSE"
export const UPDATE_APRICART_WAREHOUSE_MEMBERS_AUDIT_ACTION = "UPDATE_APRICART_WAREHOUSE_MEMBERS"
export const UPDATE_BRANCH_FULFILLMENT_ROUTES_AUDIT_ACTION = "UPDATE_BRANCH_FULFILLMENT_ROUTES"

/** Bounds: lists are capped, and one routing request names one organization's branches. */
export const APRICART_WAREHOUSE_MAX = 200
export const APRICART_WAREHOUSE_MEMBER_MAX = 200
export const BRANCH_ROUTE_MAX_PER_ORGANIZATION = 1000

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
