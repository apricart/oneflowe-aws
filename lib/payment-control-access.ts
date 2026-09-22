import { normalizePositiveIds } from "@/lib/server/analytics-scope"

/**
 * Who may see a branch's payment-control state, and who may grant or revoke
 * a Head Office exception (plans/OF-PAYMENT-CONTROL-overdue-ordering-block.md).
 *
 * Free of the database and the session, like lib/money-budget-access.ts, so
 * the rule is unit-testable and shared by the routes and the pages. The
 * handler supplies the caller's scope and — for the group roles — the branch
 * set it resolved from the assignment tables; nothing here trusts a branch
 * id sent by a client beyond narrowing to it.
 *
 *   Granting / revoking an exception
 *     SUPER_ADMIN   anywhere.
 *     HEAD_OFFICE   inside its own tenant, which the handler pins from the
 *                   session and checks against the branch row.
 *     Nobody else — a branch may never lift its own block.
 *
 *   Reading the state
 *     SUPER_ADMIN         any branch.
 *     HEAD_OFFICE         any branch of its tenant.
 *     BRANCH_ADMIN,
 *     ORDER_PORTAL        its own branch only; a request naming another is
 *                         refused, not widened.
 *     GROUP_USER,
 *     GROUP_ORDER_PORTAL  a branch in its resolved assignment set; an empty
 *                         set is a refusal, never the tenant.
 */
export const PAYMENT_CONTROL_EXCEPTION_MANAGER_ROLES = ["SUPER_ADMIN", "HEAD_OFFICE"] as const
export type PaymentControlExceptionManagerRole = (typeof PAYMENT_CONTROL_EXCEPTION_MANAGER_ROLES)[number]

const SINGLE_BRANCH_ROLES = ["BRANCH_ADMIN", "ORDER_PORTAL"] as const
const ASSIGNED_BRANCH_ROLES = ["GROUP_USER", "GROUP_ORDER_PORTAL"] as const

export function canManagePaymentControlExceptions(role: unknown): role is PaymentControlExceptionManagerRole {
  return typeof role === "string"
    && (PAYMENT_CONTROL_EXCEPTION_MANAGER_ROLES as readonly string[]).includes(role)
}

export function readsAssignedBranchesOnly(role: unknown): boolean {
  return typeof role === "string" && (ASSIGNED_BRANCH_ROLES as readonly string[]).includes(role)
}

export function readsOwnBranchOnly(role: unknown): boolean {
  return typeof role === "string" && (SINGLE_BRANCH_ROLES as readonly string[]).includes(role)
}

export type PaymentControlBranchAccess =
  | { ok: true; branchId: number }
  | { ok: false; error: string; status: number }

/**
 * Which branch a status read is for, and whether this caller may read it.
 * The tenant check on the branch row (it exists; for Head Office it is in
 * the session's organization) is the handler's, applied after this.
 */
export function resolveViewableBranch({
  role,
  sessionBranchId,
  assignedBranchIds,
  requestedBranchId,
}: {
  role: unknown
  /** `users.branch_id` from the session; meaningful for the single-branch roles. */
  sessionBranchId: unknown
  /** The group roles' resolved assignments; ignored for every other role. */
  assignedBranchIds: unknown[] | null | undefined
  requestedBranchId: unknown
}): PaymentControlBranchAccess {
  const [requested] = normalizePositiveIds([requestedBranchId])

  if (readsOwnBranchOnly(role)) {
    const [own] = normalizePositiveIds([sessionBranchId])
    if (!own) return { ok: false, error: "Branch context required", status: 400 }
    if (requested && requested !== own) return { ok: false, error: "Branch is outside your scope", status: 403 }
    return { ok: true, branchId: own }
  }

  if (readsAssignedBranchesOnly(role)) {
    const assigned = normalizePositiveIds(assignedBranchIds ?? [])
    if (assigned.length === 0) return { ok: false, error: "No branches are assigned to your account", status: 403 }
    if (!requested) return { ok: false, error: "branchId is required", status: 400 }
    if (!assigned.includes(requested)) return { ok: false, error: "Branch is outside your scope", status: 403 }
    return { ok: true, branchId: requested }
  }

  if (role === "HEAD_OFFICE" || role === "SUPER_ADMIN") {
    if (!requested) return { ok: false, error: "branchId is required", status: 400 }
    return { ok: true, branchId: requested }
  }

  return { ok: false, error: "Forbidden", status: 403 }
}

/**
 * Whether a manager may act on a branch of the given tenant. Super Admin is
 * unfenced; Head Office must be in the same organization as the branch.
 */
export function canManageExceptionForBranch({
  role,
  sessionOrganizationId,
  branchOrganizationId,
}: {
  role: unknown
  sessionOrganizationId: unknown
  branchOrganizationId: unknown
}): boolean {
  if (!canManagePaymentControlExceptions(role)) return false
  if (role === "SUPER_ADMIN") return true
  const [own] = normalizePositiveIds([sessionOrganizationId])
  const [target] = normalizePositiveIds([branchOrganizationId])
  return Boolean(own && target && own === target)
}
