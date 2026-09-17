import { normalizePositiveIds } from "@/lib/server/analytics-scope"

/**
 * Who may allocate money budgets, and to which branches.
 *
 * Free of the database and the session so the rule can be unit-tested on its
 * own and shared by the route handler and the page. The handler supplies the
 * approver's assignment rows, read from the database by user id; nothing here
 * trusts a branch list sent by a client.
 *
 *   SUPER_ADMIN   allocates anywhere; a requested branch list only narrows.
 *   HEAD_OFFICE   allocates inside its own tenant, which the handler pins from
 *                 the session; a requested branch list only narrows.
 *   GROUP_USER    allocates to the branches its group and branch assignments
 *                 reach — the same set it approves orders for — and to nothing
 *                 else. A requested list narrows within that set; an empty
 *                 result is a refusal, never the tenant.
 *
 * The ordering group role and the single-branch roles never allocate.
 */
export const MONEY_BUDGET_MANAGER_ROLES = ["SUPER_ADMIN", "HEAD_OFFICE", "GROUP_USER"] as const
export type MoneyBudgetManagerRole = (typeof MONEY_BUDGET_MANAGER_ROLES)[number]

export function canManageMoneyBudgets(role: unknown): role is MoneyBudgetManagerRole {
  return typeof role === "string"
    && (MONEY_BUDGET_MANAGER_ROLES as readonly string[]).includes(role)
}

/** Group User's allocation privilege is opt-in on the account, not the role. */
export function canManageMoneyBudgetsForAccount(role: unknown, budgetAllocationEnabled: unknown): boolean {
  return canManageMoneyBudgets(role)
    && (role !== "GROUP_USER" || budgetAllocationEnabled === true)
}

/** Roles whose allocation reach is a set of assigned branches rather than a tenant. */
export function managesAssignedBranchesOnly(role: unknown): boolean {
  return role === "GROUP_USER"
}

export type ManagedBranchScope =
  | {
    ok: true
    /**
     * The branch predicate the listing must apply. `null` means "no
     * assignment-based fence" — the tenant-wide roles, whose tenant predicate
     * the handler applies separately. Never `null`, and never empty, for the
     * approver.
     */
    branchIds: number[] | null
  }
  | { ok: false; error: string; status: number }

/**
 * The branches a listing may return to this caller.
 *
 * `buildBudgetBranchScope` in the route drops the branch predicate entirely
 * when handed an empty list, so for the approver an empty intersection is
 * turned into a refusal here rather than allowed to reach it.
 */
export function resolveManagedBranchScope({
  role,
  assignedBranchIds,
  requestedBranchIds = [],
}: {
  role: unknown
  /** The approver's resolved assignments; ignored for every other role. */
  assignedBranchIds: unknown[] | null | undefined
  requestedBranchIds?: unknown[]
}): ManagedBranchScope {
  const requested = normalizePositiveIds(requestedBranchIds)

  if (!managesAssignedBranchesOnly(role)) {
    return { ok: true, branchIds: requested.length > 0 ? requested : null }
  }

  const assigned = normalizePositiveIds(assignedBranchIds ?? [])
  if (assigned.length === 0) {
    return { ok: false, error: "No branches are assigned to your account", status: 403 }
  }

  const permitted = requested.length > 0
    ? requested.filter((branchId) => assigned.includes(branchId))
    : assigned
  if (permitted.length === 0) {
    return { ok: false, error: "Requested branches are outside your assigned scope", status: 403 }
  }

  return { ok: true, branchIds: permitted }
}

/**
 * Whether one allocation may be written to one branch. The tenant check is
 * the handler's, applied to every role before this; this is the assignment
 * check on top of it, and only the approver has one.
 */
export function canAllocateToBranch({
  role,
  assignedBranchIds,
  branchId,
}: {
  role: unknown
  assignedBranchIds: unknown[] | null | undefined
  branchId: unknown
}): boolean {
  if (!canManageMoneyBudgets(role)) return false
  if (!managesAssignedBranchesOnly(role)) return true

  const [target] = normalizePositiveIds([branchId])
  if (!target) return false
  return normalizePositiveIds(assignedBranchIds ?? []).includes(target)
}
