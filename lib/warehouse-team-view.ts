/**
 * Presentation helpers for Super Admin's warehouse assignments. Pure.
 * See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md.
 */

type Branch = { id: number; organizationId: number; name: string }
type Organization = { id: number; name: string }

/** "None", or the branch and organization counts, naming the organizations when few. */
export function describeWarehouseBranches(
  branchIds: readonly number[],
  branches: readonly Branch[],
  organizations: readonly Organization[],
): string {
  const assigned = branches.filter((branch) => branchIds.includes(branch.id))
  if (assigned.length === 0) return "None"
  const organizationIds = [...new Set(assigned.map((branch) => branch.organizationId))]
  const names = organizationIds
    .map((id) => organizations.find((organization) => organization.id === id)?.name)
    .filter((name): name is string => Boolean(name))
  const branchText = `${assigned.length} branch${assigned.length === 1 ? "" : "es"}`
  return names.length > 0 && names.length <= 3
    ? `${branchText} — ${names.join(", ")}`
    : `${branchText} in ${organizationIds.length} organizations`
}

/** The assigned branches that belong to one organization. */
export function branchesInOrganization(
  branchIds: readonly number[],
  branches: readonly Branch[],
  organizationId: number,
): number[] {
  return branches
    .filter((branch) => branch.organizationId === organizationId && branchIds.includes(branch.id))
    .map((branch) => branch.id)
    .sort((a, b) => a - b)
}

export function toggleBranch(selected: readonly number[], branchId: number): number[] {
  return selected.includes(branchId)
    ? selected.filter((id) => id !== branchId)
    : [...selected, branchId].sort((a, b) => a - b)
}

/**
 * What "Select all" (`assign`) or "Unselect all" changes among the rows shown:
 * the shown ones not yet in the wanted state, in the order shown. Rows the
 * filter hides are never touched. See plans/OF-WAREHOUSE-city-bulk-select.md.
 */
export function bulkChange<T>(shown: readonly T[], current: readonly T[], assign: boolean): T[] {
  return shown.filter((item) => current.includes(item) !== assign)
}

/** Consecutive slices of at most `size`, so each bulk request stays under its bound. */
export function inBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = []
  for (let start = 0; start < items.length; start += size) batches.push(items.slice(start, start + size))
  return batches
}

/** Every branch of the organization when not all are selected; none when all are. */
export function toggleAllBranches(selected: readonly number[], organizationBranchIds: readonly number[]): number[] {
  const allSelected = organizationBranchIds.length > 0 && organizationBranchIds.every((id) => selected.includes(id))
  return allSelected ? [] : [...organizationBranchIds].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Whole cities of chosen organizations. See plans/OF-WAREHOUSE-city-assignments.md
// and plans/OF-WAREHOUSE-city-assignments-by-organization.md.
// ---------------------------------------------------------------------------

type CityBranch = Branch & { cityKey: string | null }
type City = { key: string; label: string }
type CityCounts = City & { organizations: ReadonlyArray<{ organizationId: number; branchCount: number }> }
type Reach = { branchIds: readonly number[]; cityKeys: readonly string[]; cityOrganizationIds: readonly number[] }

/**
 * The assigned city a branch is served through, or null: its city is assigned
 * and its organization is chosen for the cities. Keys come from the server,
 * already normalised in SQL — never normalised here.
 */
export function cityCoveringBranch(
  branch: { organizationId: number; cityKey: string | null },
  reach: Pick<Reach, "cityKeys" | "cityOrganizationIds">,
): string | null {
  return branch.cityKey !== null
    && reach.cityKeys.includes(branch.cityKey)
    && reach.cityOrganizationIds.includes(branch.organizationId)
    ? branch.cityKey
    : null
}

/** Every branch a warehouse user serves: assigned one by one, or through a city. */
export function effectiveWarehouseBranchIds(reach: Reach, branches: readonly CityBranch[]): number[] {
  const ids = new Set(reach.branchIds)
  for (const branch of branches) {
    if (cityCoveringBranch(branch, reach)) ids.add(branch.id)
  }
  return [...ids].sort((a, b) => a - b)
}

/** A city as the second step offers it: counted within the chosen organizations. */
export type CityChoice = {
  key: string
  label: string
  branchCount: number
  organizationCount: number
  /** Assigned, but no chosen organization has a branch there now. Offered only to withdraw it. */
  outside: boolean
}

/**
 * The cities the chosen organizations have branches in, with their counts
 * narrowed to those organizations, followed by any assigned city none of them
 * has (so it can still be withdrawn). Built from the server's per-organization
 * counts, never from the capped branch list.
 */
export function citiesForOrganizations(
  cities: readonly CityCounts[],
  organizationIds: readonly number[],
  assignedKeys: readonly string[],
): CityChoice[] {
  const chosen = new Set(organizationIds)
  const offered: CityChoice[] = []
  const outside: CityChoice[] = []
  for (const city of cities) {
    const counts = city.organizations.filter((count) => chosen.has(count.organizationId))
    const branchCount = counts.reduce((sum, count) => sum + count.branchCount, 0)
    if (branchCount > 0) {
      offered.push({ key: city.key, label: city.label, branchCount, organizationCount: counts.length, outside: false })
    } else if (assignedKeys.includes(city.key)) {
      outside.push({ key: city.key, label: city.label, branchCount: 0, organizationCount: 0, outside: true })
    }
  }
  return [...offered, ...outside]
}

export function cityLabel(key: string, cities: readonly City[]): string {
  return cities.find((city) => city.key === key)?.label ?? key
}

/**
 * The cities, named when few, then the branches they and the single
 * assignments reach. Cities with no organization chosen reach nothing, and
 * say so.
 */
export function describeWarehouseReach(
  reach: Reach,
  branches: readonly CityBranch[],
  organizations: readonly Organization[],
  cities: readonly City[],
): string {
  const branchText = describeWarehouseBranches(effectiveWarehouseBranchIds(reach, branches), branches, organizations)
  if (reach.cityKeys.length === 0) return branchText
  const cityText = reach.cityKeys.length <= 3
    ? reach.cityKeys.map((key) => cityLabel(key, cities)).join(", ")
    : `${reach.cityKeys.length} cities`
  const empty = reach.cityOrganizationIds.length === 0 ? "no organization chosen" : "no branches yet"
  return `${cityText} · ${branchText === "None" ? empty : branchText}`
}
