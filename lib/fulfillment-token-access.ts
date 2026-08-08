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

  return Boolean(
    role === "ORDER_PORTAL" &&
    String(orderStatus || "").toUpperCase() === "APPROVED" &&
    userId &&
    orderCreatedByUserId === userId
  )
}

