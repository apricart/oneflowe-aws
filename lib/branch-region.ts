/**
 * The delivery region a branch belongs to, for the management delivery
 * dashboard (plans/OF-DELIVERY-management-delivery-dashboard.md).
 *
 * A fixed list rather than free text, so "South", "south " and "Sindh/South"
 * can never become three regions on a dashboard. The database holds the same
 * list in `branches_region_ck`; adding a region is a migration plus a line here.
 * A branch with no region reads as "Unknown".
 */
export const BRANCH_REGIONS = ["NORTH", "CENTRAL", "SOUTH"] as const

export type BranchRegion = (typeof BRANCH_REGIONS)[number]

export const BRANCH_REGION_LABELS: Record<BranchRegion, string> = {
  NORTH: "North",
  CENTRAL: "Central",
  SOUTH: "South",
}

export const UNKNOWN_REGION_LABEL = "Unknown"

export function isBranchRegion(value: unknown): value is BranchRegion {
  return typeof value === "string" && (BRANCH_REGIONS as readonly string[]).includes(value)
}

/** The stored value for whatever a form or query sent, or null for none/unknown input. */
export function normalizeBranchRegion(value: unknown): BranchRegion | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toUpperCase()
  return isBranchRegion(normalized) ? normalized : null
}

export function branchRegionLabel(value: unknown): string {
  const region = normalizeBranchRegion(value)
  return region ? BRANCH_REGION_LABELS[region] : UNKNOWN_REGION_LABEL
}
