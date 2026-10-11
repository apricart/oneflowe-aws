/**
 * Presentation rules for Super Admin's "Order approvers" list on the Order
 * Desk Team screen. Pure, so the screen's wording and its edits are tested
 * without a browser. See plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md.
 */

export type AssignableOrganizationView = { id: number; name: string }

/** "None", or the names of the assigned organizations in the order they are listed. */
export function describeExecutiveOrganizations(
  organizationIds: readonly number[],
  organizations: readonly AssignableOrganizationView[],
): string {
  if (organizationIds.length === 0) return "None — approves nothing"
  const assigned = new Set(organizationIds)
  const names = organizations.filter((organization) => assigned.has(organization.id)).map((organization) => organization.name)
  // An id with no listed organization is still assigned; say so rather than hide it.
  const unlisted = organizationIds.length - names.length
  if (unlisted > 0) names.push(`${unlisted} other${unlisted === 1 ? "" : "s"}`)
  return names.join(", ")
}

/** Tick or untick one organization; the result is sorted and unique. */
export function toggleExecutiveOrganization(organizationIds: readonly number[], organizationId: number): number[] {
  const next = new Set(organizationIds)
  if (next.has(organizationId)) next.delete(organizationId)
  else next.add(organizationId)
  return [...next].sort((a, b) => a - b)
}
