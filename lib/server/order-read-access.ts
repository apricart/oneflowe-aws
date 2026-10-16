import { viewerReadScope } from "@/lib/viewer-access"
import "server-only"

import { eq } from "drizzle-orm"

import { branches, orders } from "@/db/schema"
import { verifyResourceAccess, type RequestScope } from "@/lib/auth"
import { db } from "@/lib/db"
import { canOrderPortalReadOrder } from "@/lib/group-order-visibility"
import { canUseScopedBranch, usesMultiBranchScope } from "@/lib/server/multi-branch-scope"

/**
 * Who may read one order — the rule `GET /api/v1/orders/{id}` applies, in one
 * place, so anything attached to an order (its delivery challan) is readable by
 * exactly the people who can read the order, and the two can never drift.
 */

/** The roles the order detail admits. Every other role reads no order here. */
export const ORDER_DETAIL_READ_ROLES = [
  "SUPER_ADMIN",
  "HEAD_OFFICE",
  "BRANCH_ADMIN",
  "GROUP_USER",
  "GROUP_ORDER_PORTAL",
  "ORDER_PORTAL",
] as const

export type OrderReadOptions = {
  /**
   * Check an organization-wide Viewer as Head Office. Passed by GET handlers
   * only; see `viewerReadScope` in `lib/viewer-access.ts`.
   */
  viewerReadsAsHeadOffice?: boolean
}

/**
 * Branch authorization for reading one order.
 *
 * `verifyResourceAccess` compares the order's branch against the single branch
 * pinned on the user row, which is exactly right for SUPER_ADMIN, HEAD_OFFICE,
 * BRANCH_ADMIN and ORDER_PORTAL and is left untouched for them. Neither group
 * role has a single branch — each reaches the set of branches an administrator
 * assigned it — so both are checked against that resolved set instead, with the
 * tenant re-asserted explicitly first. An empty assignment set denies access
 * rather than widening to the organization.
 */
export async function hasBranchAccessForOrderRead(
  role: unknown,
  userId: unknown,
  scope: RequestScope | null,
  order: { organizationId: number; branchId: number },
  options: OrderReadOptions = {},
): Promise<boolean> {
  if (!usesMultiBranchScope(role)) {
    return verifyResourceAccess(order.organizationId, order.branchId, options)
  }
  if (typeof userId !== "string" || !scope || scope.userId !== userId || scope.role !== role) {
    return false
  }
  if (!scope.organizationId || scope.organizationId !== order.organizationId) return false
  return canUseScopedBranch(userId, order.branchId)
}

/**
 * Whether the caller may read this order: an admitted role, the order's branch
 * inside its own tenant, the caller's branch reach, and — for the Order Portal
 * — its own orders or its branch's group orders. Reads the order itself, by id
 * only; the answer is the caller's to turn into 404.
 */
export async function canReadOrderDetail(input: {
  orderId: number
  scope: RequestScope | null
} & OrderReadOptions): Promise<{ organizationId: number; branchId: number } | null> {
  const options: OrderReadOptions = { viewerReadsAsHeadOffice: input.viewerReadsAsHeadOffice === true }
  const scope = options.viewerReadsAsHeadOffice ? viewerReadScope(input.scope) : input.scope
  if (!scope || !(ORDER_DETAIL_READ_ROLES as readonly string[]).includes(scope.role)) return null

  const [order] = await db
    .select({
      organizationId: orders.organizationId,
      branchId: orders.branchId,
      createdByUserId: orders.createdByUserId,
      groupOrderId: orders.groupOrderId,
      branchOrganizationId: branches.organizationId,
    })
    .from(orders)
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .where(eq(orders.id, input.orderId))
    .limit(1)
  if (!order?.organizationId || order.branchOrganizationId !== order.organizationId) return null

  const reach = { organizationId: order.organizationId, branchId: order.branchId }
  if (!await hasBranchAccessForOrderRead(scope.role, scope.userId, scope, reach, options)) return null
  if (scope.role === "ORDER_PORTAL" && !canOrderPortalReadOrder({ viewerUserId: scope.userId, order })) return null
  return reach
}
