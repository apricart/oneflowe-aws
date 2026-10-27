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

type SearchableOrganization = { id: number; name: string; branches: readonly { id: number; name: string }[] }

export type VisibleReachOrganization<T extends SearchableOrganization> = {
  organization: T
  /** The organization itself matched (or there is no search): its whole tick is in play. */
  matchedWhole: boolean
  /** The branches to list under it. */
  branches: T["branches"]
}

/**
 * What the reach editor lists for a search. An organization whose name
 * matches is listed with every branch; otherwise only with the branches whose
 * names match, and not at all when none do. Matching ignores case and
 * surrounding space; an empty search lists everything.
 */
export function filterReachOrganizations<T extends SearchableOrganization>(
  organizations: readonly T[],
  query: string,
): VisibleReachOrganization<T>[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return organizations.map((organization) => ({ organization, matchedWhole: true, branches: organization.branches }))
  const visible: VisibleReachOrganization<T>[] = []
  for (const organization of organizations) {
    if (organization.name.toLowerCase().includes(needle)) {
      visible.push({ organization, matchedWhole: true, branches: organization.branches })
      continue
    }
    const branches = organization.branches.filter((branch) => branch.name.toLowerCase().includes(needle))
    if (branches.length > 0) visible.push({ organization, matchedWhole: false, branches })
  }
  return visible
}

/**
 * Select all / Unselect all over what the editor is listing.
 *
 * Selecting grants a listed organization whole when the organization itself
 * is listed, and only the listed branches when it is there for a branch match
 * — a search for one branch must not grant the rest. Unselecting withdraws
 * exactly what the listed checkboxes show: a whole grant (which hides the
 * branch list) or the listed branches.
 */
export function setVisibleReach(
  draft: DeskReachDraft,
  visible: readonly VisibleReachOrganization<SearchableOrganization>[],
  selected: boolean,
): DeskReachDraft {
  const next = { organizationIds: new Set(draft.organizationIds), branchIds: new Set(draft.branchIds) }
  for (const entry of visible) {
    if (selected) selectVisibleEntry(next, entry)
    else unselectVisibleEntry(next, entry)
  }
  return next
}

type MutableReach = { organizationIds: Set<number>; branchIds: Set<number> }

function selectVisibleEntry(
  reach: MutableReach,
  { organization, matchedWhole, branches }: VisibleReachOrganization<SearchableOrganization>,
): void {
  if (matchedWhole) {
    reach.organizationIds.add(organization.id)
    for (const branch of organization.branches) reach.branchIds.delete(branch.id)
  } else if (!reach.organizationIds.has(organization.id)) {
    for (const branch of branches) reach.branchIds.add(branch.id)
  }
}

function unselectVisibleEntry(
  reach: MutableReach,
  { organization, matchedWhole, branches }: VisibleReachOrganization<SearchableOrganization>,
): void {
  if (matchedWhole) {
    reach.organizationIds.delete(organization.id)
    for (const branch of organization.branches) reach.branchIds.delete(branch.id)
  } else if (reach.organizationIds.has(organization.id)) {
    reach.organizationIds.delete(organization.id)
  } else {
    for (const branch of branches) reach.branchIds.delete(branch.id)
  }
}
