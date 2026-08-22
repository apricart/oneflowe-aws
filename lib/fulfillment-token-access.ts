type FulfillmentTokenAccessInput = {
  role?: string | null
  userId?: string | null
  orderStatus?: string | null
  orderCreatedByUserId?: string | null
  orderApprovedByUserId?: string | null
  configuredApproverRole?: string | null
}

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

  return Boolean(
    role === "ORDER_PORTAL" &&
    String(orderStatus || "").toUpperCase() === "APPROVED" &&
    userId &&
    orderCreatedByUserId === userId
  )
}

