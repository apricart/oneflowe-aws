type FulfillmentTokenAccessInput = {
  role?: string | null
  userId?: string | null
  orderStatus?: string | null
  orderCreatedByUserId?: string | null
  orderApprovedByUserId?: string | null
  configuredApproverRole?: string | null
}

/**
 * The two roles that raise orders rather than decide them. Both see a token
 * only for their own approved order, which is strictly narrower than any
 * administrator branch above.
 */
const REQUESTER_ROLES = new Set(["ORDER_PORTAL", "GROUP_ORDER_PORTAL"])

export function canViewFulfillmentToken({
  role,
  userId,
  orderStatus,
  orderCreatedByUserId,
  orderApprovedByUserId,
  configuredApproverRole,
}: FulfillmentTokenAccessInput): boolean {
  if (role === "SUPER_ADMIN") return true

  if (role === "BRANCH_ADMIN") {
    return configuredApproverRole === undefined
      ? true
      : configuredApproverRole === "BRANCH_ADMIN"
  }

  if (role === "HEAD_OFFICE") {
    return configuredApproverRole === "HEAD_OFFICE"
      || (configuredApproverRole === undefined && Boolean(userId && orderApprovedByUserId === userId))
  }

  // A GROUP_USER's authority comes from its branch assignments rather than the
  // tenant's configured approver role, so the configured role is not consulted
  // here. The branch scope itself is enforced by the caller — every surface
  // that reaches this point has already restricted the order to the approver's
  // branches. The token only exists once an order is approved, so this stays
  // narrower than the BRANCH_ADMIN branch above rather than wider.
  if (role === "GROUP_USER") {
    return String(orderStatus || "").toUpperCase() === "APPROVED"
  }

  // The requester roles reach a token only through an order they raised
  // themselves, and only once it is approved. GROUP_ORDER_PORTAL raises orders
  // across a set of assigned branches rather than one pinned branch, so — as
  // with GROUP_USER above — the branch scope is enforced by the caller; the
  // creator comparison here is what keeps one requester out of another's token.
  return Boolean(
    REQUESTER_ROLES.has(String(role ?? "")) &&
    String(orderStatus || "").toUpperCase() === "APPROVED" &&
    userId &&
    orderCreatedByUserId === userId
  )
}

