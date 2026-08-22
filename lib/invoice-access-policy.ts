import { isValidRole, type Role } from "@/lib/rbac"
import { isInvoiceAvailableForOrder } from "@/lib/invoice-availability"

/**
 * The parts of an order the invoice decision looks at. Structural on purpose so
 * this policy stays free of database imports and can be exercised directly.
 */
export type InvoiceOrderSubject = {
  organizationId: number | null
  branchId: number | null
  createdByUserId: string
  status: string | null
  statusAtRefund?: string | null
  receiptData?: unknown
}

/**
 * The parts of the authenticated caller the invoice decision looks at.
 *
 * `scopedBranchIds` carries the branch set of the group-based roles, resolved
 * from their group and branch assignments. It is required for those roles and
 * unused by every other role; an empty set means "no branches" and is never
 * read as "every branch".
 */
export type InvoiceRequesterScope = {
  userId: string
  organizationId: number | null
  branchId: number | null
  scopedBranchIds?: number[] | null
}

export type InvoiceAccessDenial = {
  status: 401 | 403 | 404 | 409
  error: string
}

/**
 * How far one role reaches when reading an invoice.
 *
 * `tenant`      — "platform" crosses organizations; every other role is pinned
 *                 to its own.
 * `branches`    — which branches inside that tenant it may read.
 * `ownOrdersOnly` — whether it is further limited to orders it placed itself.
 */
type InvoiceRoleRule = {
  tenant: "platform" | "own-organization"
  branches: "all" | "own-organization" | "own-branch" | "assigned"
  ownOrdersOnly: boolean
}

/**
 * Every role's invoice reach in one table, each entry mirroring the scope that
 * role already has on the list it opens the invoice from:
 *
 *  - SUPER_ADMIN         — the platform, like everywhere else.
 *  - HEAD_OFFICE         — its whole organization.
 *  - BRANCH_ADMIN        — its own branch, like the orders directory.
 *  - ORDER_PORTAL        — its own orders, like the store's order list.
 *  - GROUP_ORDER_PORTAL  — the orders it raised, across the branches it ordered
 *                          for, like its group order history.
 *  - GROUP_USER          — every order in its assigned branches, like its
 *                          approval queue.
 */
const INVOICE_ROLE_RULES: Record<Role, InvoiceRoleRule> = {
  SUPER_ADMIN: { tenant: "platform", branches: "all", ownOrdersOnly: false },
  HEAD_OFFICE: { tenant: "own-organization", branches: "own-organization", ownOrdersOnly: false },
  BRANCH_ADMIN: { tenant: "own-organization", branches: "own-branch", ownOrdersOnly: false },
  ORDER_PORTAL: { tenant: "own-organization", branches: "own-branch", ownOrdersOnly: true },
  GROUP_ORDER_PORTAL: { tenant: "own-organization", branches: "own-organization", ownOrdersOnly: true },
  GROUP_USER: { tenant: "own-organization", branches: "assigned", ownOrdersOnly: false },
}

/** Roles whose branch reach comes from group and branch assignments. */
export function invoiceScopeNeedsAssignedBranches(role: Role | string | null | undefined): boolean {
  return typeof role === "string"
    && isValidRole(role)
    && INVOICE_ROLE_RULES[role].branches === "assigned"
}

const UNAUTHORIZED: InvoiceAccessDenial = { status: 401, error: "Unauthorized" }
const FORBIDDEN: InvoiceAccessDenial = {
  status: 403,
  error: "Forbidden: You do not have access to this invoice",
}
export const ORDER_NOT_FOUND: InvoiceAccessDenial = { status: 404, error: "Order not found" }
const INVOICE_NOT_FOUND: InvoiceAccessDenial = { status: 404, error: "Invoice not found" }
const NOT_YET_AVAILABLE: InvoiceAccessDenial = {
  status: 409,
  error: "Invoice is available after the order is approved",
}

function isWithinBranchScope(
  rule: InvoiceRoleRule,
  scope: InvoiceRequesterScope,
  order: InvoiceOrderSubject,
): boolean {
  switch (rule.branches) {
    case "all":
    case "own-organization":
      // The organization check above is the whole restriction here.
      return true
    case "own-branch":
      return scope.branchId !== null
        && scope.branchId !== undefined
        && order.branchId === scope.branchId
    case "assigned":
      // Fail closed: no assignments means no branches, never all branches.
      return Boolean(order.branchId)
        && Array.isArray(scope.scopedBranchIds)
        && scope.scopedBranchIds.includes(order.branchId as number)
  }
}

/**
 * The single decision for "may this caller read this invoice", shared by the
 * invoice preview and download endpoints.
 *
 * Returns null when access is granted, or the denial to send back. Checks run
 * isolation first so a caller outside the tenant learns nothing about the
 * order's existence or state.
 */
export function resolveInvoiceAccess(input: {
  role: Role | string | null | undefined
  scope: InvoiceRequesterScope | null | undefined
  order: InvoiceOrderSubject | null | undefined
}): InvoiceAccessDenial | null {
  const { role, scope, order } = input

  if (!scope?.userId || !role || !isValidRole(role)) return UNAUTHORIZED

  const rule = INVOICE_ROLE_RULES[role]
  if (!order) return ORDER_NOT_FOUND

  // Tenant isolation. Every role other than the platform administrator must
  // belong to a known organization and the order must belong to the same one;
  // an unknown organization on either side fails closed rather than skipping
  // the comparison.
  if (rule.tenant === "own-organization") {
    if (
      scope.organizationId === null ||
      scope.organizationId === undefined ||
      order.organizationId === null ||
      order.organizationId === undefined ||
      scope.organizationId !== order.organizationId
    ) {
      return FORBIDDEN
    }
  }

  // Branch scope inside the tenant.
  if (!isWithinBranchScope(rule, scope, order)) return FORBIDDEN

  // Ownership, for the roles that only ever see their own orders.
  if (rule.ownOrdersOnly && order.createdByUserId !== scope.userId) return FORBIDDEN

  // Identical availability rules for every role: an invoice exists only once
  // the order is approved, and stays available through fulfillment and refund.
  if (!isInvoiceAvailableForOrder(order)) return NOT_YET_AVAILABLE
  if (!order.receiptData) return INVOICE_NOT_FOUND

  return null
}
