type OrderEditPolicyInput = {
  actorRole: string | null | undefined
  actorUserId: string | null | undefined
  actorOrganizationId: number | null | undefined
  actorBranchId: number | null | undefined
  orderStatus: string | null | undefined
  orderCreatedByUserId: string | null | undefined
  orderOrganizationId: number | null | undefined
  orderBranchId: number | null | undefined
  branchOrganizationId: number | null | undefined
}

/**
 * Order edits are intentionally narrower than order visibility. Only the
 * Order Portal user who created a still-pending order may edit it, and every
 * tenant/branch boundary must agree.
 */
export function canOrderPortalEditOrder(input: OrderEditPolicyInput): boolean {
  return input.actorRole === "ORDER_PORTAL"
    && Boolean(input.actorUserId)
    && input.actorUserId === input.orderCreatedByUserId
    && typeof input.actorOrganizationId === "number"
    && input.actorOrganizationId === input.orderOrganizationId
    && typeof input.actorBranchId === "number"
    && input.actorBranchId === input.orderBranchId
    && input.branchOrganizationId === input.orderOrganizationId
    && String(input.orderStatus || "").toUpperCase() === "PENDING"
}
