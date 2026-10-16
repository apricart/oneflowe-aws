/**
 * What the user directory shows in a user's Branch column.
 *
 * A user's branch has three sources depending on the role: a single-branch role
 * carries `branchId`, a group-based role carries the branches its group and
 * branch assignments resolve to (`assignedBranches`, null for every other
 * role), and a tenant-wide role carries neither. Falling back to "Head Office"
 * for anything without a `branchId` mislabelled every group user, which is why
 * the rule lives here rather than inline in the table.
 */

export type DirectoryBranch = { id: number; name: string }

export type UserBranchDisplayInput = {
  role: string
  branchId?: number | null
  assignedBranches?: DirectoryBranch[] | null
}

export type UserBranchDisplay =
  | { kind: "single"; label: string; branches: DirectoryBranch[] }
  | { kind: "multiple"; label: string; branches: DirectoryBranch[] }
  | { kind: "none"; label: string; branches: [] }

/** The label shown when a user reaches more than one branch. */
export const MULTIPLE_BRANCHES_LABEL = "Multiple"

/** Roles that read the whole tenant, so they have no branch of their own. */
const TENANT_WIDE_LABELS: Readonly<Record<string, string>> = {
  HEAD_OFFICE: "Head Office",
  // A Viewer without a branch reads the whole tenant (`resolveViewerScope`).
  VIEWER: "All branches",
}

export function describeUserBranches(
  user: UserBranchDisplayInput,
  branchNameById: ReadonlyMap<number, string>,
): UserBranchDisplay {
  if (user.assignedBranches) {
    const branches = user.assignedBranches
    if (branches.length > 1) return { kind: "multiple", label: MULTIPLE_BRANCHES_LABEL, branches }
    if (branches.length === 1) return { kind: "single", label: branches[0].name, branches }
    return { kind: "none", label: "No branches", branches: [] }
  }

  if (user.branchId) {
    const name = branchNameById.get(user.branchId) ?? "Unknown"
    return { kind: "single", label: name, branches: [{ id: user.branchId, name }] }
  }

  return { kind: "none", label: TENANT_WIDE_LABELS[user.role] ?? "—", branches: [] }
}

/** The Branch cell of an export, where a hover list is not available. */
export function userBranchExportText(display: UserBranchDisplay): string {
  return display.kind === "multiple"
    ? display.branches.map((branch) => branch.name).join("; ")
    : display.label
}
