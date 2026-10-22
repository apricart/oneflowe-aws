/**
 * A branch's place in its organization: a parent branch, a child of one, or
 * standalone. Every rule that does not need a database.
 *
 * A label only (plans/OF-BRANCH-parent-child-label.md): nothing here, and
 * nothing that reads these columns, changes who may see, order, approve, spend,
 * price or stock anything. One level only — a parent is never a child, a child
 * is never a parent, and a child's parent is in its own organization. The
 * database holds the same rules (`branches_hierarchy_role_ck`,
 * `branches_hierarchy_parent_ck`, `branches_parent_org_fk` and the
 * `branches_hierarchy_guard` trigger); the routes check first so the caller
 * gets a specific message.
 */

/** Pinned by `branches_hierarchy_role_ck`. */
export const BRANCH_HIERARCHY_ROLES = ["STANDALONE", "PARENT", "CHILD"] as const

export type BranchHierarchyRole = (typeof BRANCH_HIERARCHY_ROLES)[number]

/** Every branch that existed before the label, and every branch nobody labels. */
export const DEFAULT_BRANCH_HIERARCHY_ROLE: BranchHierarchyRole = "STANDALONE"

export const BRANCH_HIERARCHY_LABELS: Record<BranchHierarchyRole, string> = {
  STANDALONE: "Standalone",
  PARENT: "Parent",
  CHILD: "Child",
}

/** The most parents one report filter may name. A bound, not a rule. */
export const MAX_PARENT_BRANCH_FILTER_IDS = 200

export function isBranchHierarchyRole(value: unknown): value is BranchHierarchyRole {
  return typeof value === "string"
    && (BRANCH_HIERARCHY_ROLES as readonly string[]).includes(value)
}

/** A stored or received role, read leniently for display: anything else is Standalone. */
export function normalizeBranchHierarchyRole(value: unknown): BranchHierarchyRole {
  return isBranchHierarchyRole(value) ? value : DEFAULT_BRANCH_HIERARCHY_ROLE
}

export type BranchHierarchy = {
  hierarchyRole: BranchHierarchyRole
  parentBranchId: number | null
}

export type BranchHierarchyInput = {
  hierarchyRole?: BranchHierarchyRole
  parentBranchId?: number | null
}

export const CHILD_NEEDS_PARENT_MESSAGE = "Choose the parent branch for a child branch"
export const ONLY_CHILD_HAS_PARENT_MESSAGE = "Only a child branch has a parent branch"
export const OWN_PARENT_MESSAGE = "A branch cannot be its own parent"

/**
 * Why a new branch's type and parent cannot stand together, or null. Absent
 * fields mean Standalone with no parent.
 */
export function branchHierarchyInputError(input: BranchHierarchyInput): string | null {
  const role = input.hierarchyRole ?? DEFAULT_BRANCH_HIERARCHY_ROLE
  const hasParent = input.parentBranchId !== undefined && input.parentBranchId !== null
  if (role === "CHILD" && !hasParent) return CHILD_NEEDS_PARENT_MESSAGE
  if (role !== "CHILD" && hasParent) return ONLY_CHILD_HAS_PARENT_MESSAGE
  return null
}

/** The hierarchy a valid create input stores. */
export function hierarchyForNewBranch(input: BranchHierarchyInput): BranchHierarchy {
  const hierarchyRole = input.hierarchyRole ?? DEFAULT_BRANCH_HIERARCHY_ROLE
  return {
    hierarchyRole,
    parentBranchId: hierarchyRole === "CHILD" ? input.parentBranchId ?? null : null,
  }
}

export type BranchHierarchyPlan =
  | { kind: "unchanged" }
  | {
    kind: "change"
    next: BranchHierarchy
    /** The branch stops being a parent: refused while it has children. */
    demotesParent: boolean
    /** The new parent must be checked: in this organization and a parent. */
    checksParent: boolean
  }
  | { kind: "refused"; message: string }

/**
 * The parent an edit leaves the branch with, or why it cannot have that one.
 * A child keeps its current parent unless the edit names another; anything
 * else has none.
 */
function requestedParent(
  branchId: number,
  hierarchyRole: BranchHierarchyRole,
  current: BranchHierarchy,
  requestedParentId: number | null | undefined,
): number | null | string {
  if (hierarchyRole !== "CHILD") {
    return requestedParentId === undefined || requestedParentId === null ? null : ONLY_CHILD_HAS_PARENT_MESSAGE
  }
  const inherited = current.hierarchyRole === "CHILD" ? current.parentBranchId : null
  const parentBranchId = requestedParentId === undefined ? inherited : requestedParentId
  if (parentBranchId === null) return CHILD_NEEDS_PARENT_MESSAGE
  if (parentBranchId === branchId) return OWN_PARENT_MESSAGE
  return parentBranchId
}

/**
 * What an edit does to a branch's hierarchy. Either field may be absent:
 * `parentBranchId` alone re-parents a child, and a role other than Child clears
 * the parent. A request that restates the current values is unchanged.
 */
export function planBranchHierarchyChange(
  branchId: number,
  current: BranchHierarchy,
  requested: BranchHierarchyInput,
): BranchHierarchyPlan {
  if (requested.hierarchyRole === undefined && requested.parentBranchId === undefined) {
    return { kind: "unchanged" }
  }

  const hierarchyRole = requested.hierarchyRole ?? current.hierarchyRole
  const parent = requestedParent(branchId, hierarchyRole, current, requested.parentBranchId)
  if (typeof parent === "string") return { kind: "refused", message: parent }
  const parentBranchId = parent

  if (hierarchyRole === current.hierarchyRole && parentBranchId === current.parentBranchId) {
    return { kind: "unchanged" }
  }
  return {
    kind: "change",
    next: { hierarchyRole, parentBranchId },
    demotesParent: current.hierarchyRole === "PARENT" && hierarchyRole !== "PARENT",
    checksParent: hierarchyRole === "CHILD",
  }
}

type DescribableBranch = {
  hierarchyRole?: unknown
  parentBranchName?: string | null
}

/** One line for a list cell or a detail panel: "Parent branch", "Child of X", "Standalone". */
export function describeBranchHierarchy(branch: DescribableBranch): string {
  const role = normalizeBranchHierarchyRole(branch.hierarchyRole)
  if (role === "PARENT") return "Parent branch"
  if (role === "CHILD") return branch.parentBranchName ? `Child of ${branch.parentBranchName}` : "Child branch"
  return "Standalone"
}

export type BranchHierarchyFilter = "all" | BranchHierarchyRole

/** The branch-list type filter. */
export function matchesBranchHierarchyFilter(
  branch: { hierarchyRole?: unknown },
  filter: BranchHierarchyFilter,
): boolean {
  return filter === "all" || normalizeBranchHierarchyRole(branch.hierarchyRole) === filter
}

export type ParentBranchCandidate = {
  id: number
  name: string
  organizationId?: number | null
  hierarchyRole?: unknown
  status?: string | null
}

/**
 * The branches a child of this organization may name as its parent: its
 * organization's parent branches, never the branch being edited, by name. The
 * server re-checks every rule whatever the form sends.
 */
export function parentBranchOptions(
  branches: readonly ParentBranchCandidate[],
  organizationId: number | null | undefined,
  excludeBranchId?: number,
): Array<{ id: number; name: string; status: string | null }> {
  if (!organizationId) return []
  return branches
    .filter((branch) => branch.organizationId === organizationId
      && branch.id !== excludeBranchId
      && normalizeBranchHierarchyRole(branch.hierarchyRole) === "PARENT")
    .map((branch) => ({ id: branch.id, name: branch.name, status: branch.status ?? null }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * `hierarchyRoles=PARENT,CHILD` on a report query. Null when malformed; an
 * empty list when absent. Duplicates collapse.
 */
export function parseHierarchyRolesParam(raw: string | null | undefined): BranchHierarchyRole[] | null {
  if (raw === null || raw === undefined || raw.trim() === "") return []
  const roles = new Set<BranchHierarchyRole>()
  for (const part of raw.split(",")) {
    const value = part.trim().toUpperCase()
    if (!isBranchHierarchyRole(value)) return null
    roles.add(value)
  }
  return [...roles]
}

/**
 * `parentBranchIds=1,2` on a report query. Null when malformed or over
 * `MAX_PARENT_BRANCH_FILTER_IDS`; an empty list when absent.
 */
export function parseParentBranchIdsParam(raw: string | null | undefined): number[] | null {
  if (raw === null || raw === undefined || raw.trim() === "") return []
  const ids = new Set<number>()
  for (const part of raw.split(",")) {
    const value = part.trim()
    if (!/^\d{1,10}$/.test(value)) return null
    const id = Number(value)
    if (id <= 0 || id > 2_147_483_647) return null
    ids.add(id)
  }
  return ids.size > MAX_PARENT_BRANCH_FILTER_IDS ? null : [...ids]
}

export type BranchReportRow = {
  id: number | string
  name: string
  status?: string | null
  hierarchyRole?: unknown
  parentBranchId?: number | null
  parentBranchName?: string | null
  parentBranchStatus?: string | null
  totalOrders: number
  fulfilledOrders: number
  revenue: number | null
  refunds: number | null
}

export type RolledUpBranchRow<T extends BranchReportRow> = T & {
  /** Branches folded into this row: 1 for a branch on its own. */
  memberCount: number
  /** Children folded in. */
  childCount: number
}

/** A money column summed; null only when every member's figure is hidden. */
function sumNullable(values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => typeof value === "number")
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0)
}

/**
 * The Branch Report rolled up by parent: one row per family (the parent and
 * every child the report holds, under the parent's name and status, keyed
 * `parent-<id>`), and every standalone branch as it was. A child whose parent
 * the filters left out still rolls up under its parent's name. Figures are
 * integer cents and counts, summed exactly. Ordered by figure, largest first,
 * so the rank badge reads the rolled-up ranking.
 */
export function rollUpBranchRowsByParent<T extends BranchReportRow>(rows: readonly T[]): Array<RolledUpBranchRow<T>> {
  const families = new Map<number, { parent: T | null; children: T[] }>()
  const standalone: T[] = []

  for (const row of rows) {
    const role = normalizeBranchHierarchyRole(row.hierarchyRole)
    if (role === "CHILD" && row.parentBranchId) {
      const family = families.get(row.parentBranchId) ?? { parent: null, children: [] }
      family.children.push(row)
      families.set(row.parentBranchId, family)
    } else if (role === "PARENT" && typeof row.id === "number") {
      const family = families.get(row.id) ?? { parent: null, children: [] }
      family.parent = row
      families.set(row.id, family)
    } else {
      standalone.push(row)
    }
  }

  const rolled: Array<RolledUpBranchRow<T>> = standalone.map((row) => ({ ...row, memberCount: 1, childCount: 0 }))
  for (const [parentId, family] of families) {
    const members = family.parent ? [family.parent, ...family.children] : family.children
    const base = family.parent ?? family.children[0]
    rolled.push({
      ...base,
      id: `parent-${parentId}`,
      name: family.parent?.name ?? base.parentBranchName ?? `Branch ${parentId}`,
      status: family.parent ? family.parent.status : base.parentBranchStatus ?? null,
      hierarchyRole: "PARENT",
      parentBranchId: null,
      parentBranchName: null,
      totalOrders: members.reduce((total, member) => total + (member.totalOrders || 0), 0),
      fulfilledOrders: members.reduce((total, member) => total + (member.fulfilledOrders || 0), 0),
      revenue: sumNullable(members.map((member) => member.revenue)),
      refunds: sumNullable(members.map((member) => member.refunds)),
      memberCount: members.length,
      childCount: family.children.length,
    })
  }

  return rolled.sort((left, right) => ((right.revenue ?? 0) - (left.revenue ?? 0))
    || (right.totalOrders - left.totalOrders))
}
