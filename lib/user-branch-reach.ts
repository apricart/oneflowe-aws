/**
 * Whether a user in the directory belongs under a branch filter.
 *
 * A single-branch user (Branch Admin, Order Portal) is at the branch its own
 * `branchId` names. A group-based user (Group User, Group Order Portal) has no
 * `branchId`; its branches are its assignments, which `GET /api/v1/users`
 * returns as `assignedBranches`. Filtering on `branchId` alone hid every
 * group-based user — including the approvers and the initiator a department
 * join request creates for a request that names more than one branch.
 */
export type DirectoryUserBranchReach = {
  branchId?: number | null
  assignedBranches?: ReadonlyArray<{ id: number }> | null
}

export function userReachesAnyBranch(
  user: DirectoryUserBranchReach,
  branchIds: ReadonlySet<number>,
): boolean {
  if (user.branchId != null && branchIds.has(Number(user.branchId))) return true
  return (user.assignedBranches ?? []).some((branch) => branchIds.has(Number(branch.id)))
}
