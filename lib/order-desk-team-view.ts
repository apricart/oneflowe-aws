/**
 * The Order Desk Team screen's reach editor, as pure functions. What a desk
 * user may actually reach is decided on the server (`lib/order-desk-access.ts`);
 * these only shape what Super Admin ticks before it is sent.
 */

export type DeskReachDraft = {
  /** Organizations granted whole: every branch. */
  organizationIds: ReadonlySet<number>
  /** Single branches of organizations not granted whole. */
  branchIds: ReadonlySet<number>
}

/**
 * What the Access dialog opens with: the member's grants, narrowed to the
 * managed organizations the editor can show.
 *
 * A grant to an organization that has since stopped being managed reaches
 * nothing — the server ignores it — and has no checkbox, so it cannot be
 * unticked. The server also refuses to store it again, so carrying it into the
 * draft would make every save for this person fail. Saving drops it instead.
 */
export function reachDraftFor(
  member: { organizationIds: readonly number[]; branchIds: readonly number[] },
  organizations: readonly { id: number; branches: readonly { id: number }[] }[],
): DeskReachDraft {
  const shown = new Set(organizations.map((organization) => organization.id))
  const organizationIds = new Set(member.organizationIds.filter((id) => shown.has(id)))
  const branchIds = new Set<number>()
  for (const organization of organizations) {
    if (organizationIds.has(organization.id)) continue
    for (const branch of organization.branches) {
      if (member.branchIds.includes(branch.id)) branchIds.add(branch.id)
    }
  }
  return { organizationIds, branchIds }
}

/**
 * Tick or untick a whole organization. Ticking it makes its single-branch
 * grants redundant, so they are dropped rather than sent twice.
 */
export function toggleReachOrganization(
  draft: DeskReachDraft,
  organizationId: number,
  organizationBranchIds: readonly number[],
): DeskReachDraft {
  const organizationIds = new Set(draft.organizationIds)
  const branchIds = new Set(draft.branchIds)
  if (organizationIds.has(organizationId)) {
    organizationIds.delete(organizationId)
  } else {
    organizationIds.add(organizationId)
    for (const branchId of organizationBranchIds) branchIds.delete(branchId)
  }
  return { organizationIds, branchIds }
}

export function toggleReachBranch(draft: DeskReachDraft, branchId: number): DeskReachDraft {
  const branchIds = new Set(draft.branchIds)
  if (branchIds.has(branchId)) branchIds.delete(branchId)
  else branchIds.add(branchId)
  return { organizationIds: new Set(draft.organizationIds), branchIds }
}

type ReachOrganization = { id: number; name: string; branches: { id: number; name: string }[] }

/** One line for the team table: what this desk user may order for. */
export function describeDeskReach(
  member: { organizationIds: readonly number[]; branchIds: readonly number[] },
  organizations: readonly ReachOrganization[],
): string {
  const parts: string[] = []
  for (const organization of organizations) {
    if (member.organizationIds.includes(organization.id)) {
      parts.push(`${organization.name} (all branches)`)
      continue
    }
    const branchNames = organization.branches
      .filter((branch) => member.branchIds.includes(branch.id))
      .map((branch) => branch.name)
    if (branchNames.length > 0) parts.push(`${organization.name}: ${branchNames.join(", ")}`)
  }
  return parts.length > 0 ? parts.join("; ") : "No access"
}
