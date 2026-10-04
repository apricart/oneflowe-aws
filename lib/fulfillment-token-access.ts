type FulfillmentTokenAccessInput = {
  role?: string | null
  orderStatus?: string | null
  /**
   * Retained for call-site compatibility. Identity and branch authorization
   * belong to the server query/route that loaded the order; this pure policy
   * only decides whether a role may use a token after that scope check passed.
   */
  userId?: string | null
  orderCreatedByUserId?: string | null
  orderApprovedByUserId?: string | null
  configuredApproverRole?: string | null
}

/**
 * Roles that may complete the ordering side of an approved order by handing
 * its fulfillment token to admin operations.
 *
 * This is deliberately a role/status decision, not a scope decision. Every
 * caller must first restrict the order to the actor's tenant and branch reach:
 * Head Office to its tenant, single-branch roles to their branch, group roles
 * to their live assignments, and Order Portal to an order it may read. Keeping
 * that boundary server-side lets all five operational roles fulfill orders
 * without turning a token into a cross-tenant or cross-branch credential.
 */
const TOKEN_HANDOFF_ROLES = new Set([
  "HEAD_OFFICE",
  "GROUP_USER",
  "BRANCH_ADMIN",
  "GROUP_ORDER_PORTAL",
  "ORDER_PORTAL",
])

export function canViewFulfillmentToken(input: FulfillmentTokenAccessInput): boolean {
  const { role, orderStatus } = input
  if (role === "SUPER_ADMIN") return true
  return TOKEN_HANDOFF_ROLES.has(String(role ?? ""))
    && String(orderStatus || "").trim().toUpperCase() === "APPROVED"
}
