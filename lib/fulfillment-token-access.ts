type FulfillmentTokenAccessInput = {
  role?: string | null
  userId?: string | null
  orderStatus?: string | null
  orderCreatedByUserId?: string | null
  orderApprovedByUserId?: string | null
}

export function canViewFulfillmentToken({
  role,
  userId,
  orderStatus,
  orderCreatedByUserId,
  orderApprovedByUserId,
}: FulfillmentTokenAccessInput): boolean {
  if (role === "SUPER_ADMIN" || role === "BRANCH_ADMIN") return true

  if (userId && orderApprovedByUserId === userId) return true

  return Boolean(
    role === "ORDER_PORTAL" &&
    String(orderStatus || "").toUpperCase() === "APPROVED" &&
    userId &&
    orderCreatedByUserId === userId
  )
}

