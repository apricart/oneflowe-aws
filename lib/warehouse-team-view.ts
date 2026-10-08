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

/** Every branch of the organization when not all are selected; none when all are. */
export function toggleAllBranches(selected: readonly number[], organizationBranchIds: readonly number[]): number[] {
  const allSelected = organizationBranchIds.length > 0 && organizationBranchIds.every((id) => selected.includes(id))
  return allSelected ? [] : [...organizationBranchIds].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Whole cities. See plans/OF-WAREHOUSE-city-assignments.md.
// ---------------------------------------------------------------------------

type CityBranch = Branch & { cityKey: string | null }
type City = { key: string; label: string }
type Reach = { branchIds: readonly number[]; cityKeys: readonly string[] }

/**
 * The assigned city a branch is served through, or null. Keys come from the
 * server, already normalised in SQL — never normalised here.
 */
export function cityCoveringBranch(branch: { cityKey: string | null }, cityKeys: readonly string[]): string | null {
  return branch.cityKey !== null && cityKeys.includes(branch.cityKey) ? branch.cityKey : null
}

/** Every branch a warehouse user serves: assigned one by one, or through a city. */
export function effectiveWarehouseBranchIds(reach: Reach, branches: readonly CityBranch[]): number[] {
  const ids = new Set(reach.branchIds)
  for (const branch of branches) {
    if (cityCoveringBranch(branch, reach.cityKeys)) ids.add(branch.id)
  }
  return [...ids].sort((a, b) => a - b)
}

export function cityLabel(key: string, cities: readonly City[]): string {
  return cities.find((city) => city.key === key)?.label ?? key
}

/** The cities, named when few, then the branches they and the single assignments reach. */
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
  return `${cityText} · ${branchText === "None" ? "no branches yet" : branchText}`
}
