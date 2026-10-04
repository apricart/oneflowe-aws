/**
 * Who reads an order that the Group Order Portal raised for a branch.
 *
 * A Group Order Portal submission is recorded as one ordinary `orders` row per
 * branch, linked back to its envelope through the nullable `groupOrderId`. Such
 * an order is placed *on behalf of* the branch: it spends that branch's budget
 * and is delivered there. The branch's own people therefore read it exactly as
 * they read any other order of theirs.
 *
 * `groupOrderId` is null on every order created by any other flow, so a rule
 * keyed on it cannot change who sees an order that already exists.
 *
 * This module decides **ownership only**. Tenant and branch scope stay with each
 * caller, as they do for `canViewFulfillmentToken` — every surface that consults
 * these helpers has already restricted the order to the caller's organization
 * and branch.
 */

/** The shape of an order this module needs. Structural so it stays DB-free. */
export type GroupOrderVisibilitySubject = {
  createdByUserId: string | null | undefined
  groupOrderId: number | null | undefined
}

/** True when the order was raised through a Group Order Portal submission. */
export function isGroupPortalOrder(
  order: { groupOrderId?: number | null } | null | undefined,
): boolean {
  return typeof order?.groupOrderId === "number"
}

/**
 * May an Order Portal user read this order?
 *
 * Either it is one they raised themselves — the rule that has always applied —
 * or it is a group order raised for their branch. Callers may layer separately
 * authorized branch actions on this read scope; the tenant and branch checks
 * must still pass before any token or write is released.
 */
export function canOrderPortalReadOrder(input: {
  viewerUserId: string | null | undefined
  order: GroupOrderVisibilitySubject | null | undefined
}): boolean {
  const { viewerUserId, order } = input
  if (!order) return false
  if (isGroupPortalOrder(order)) return true
  return Boolean(viewerUserId) && order.createdByUserId === viewerUserId
}

/**
 * The roles that *raise* orders, as opposed to deciding them.
 *
 * User-attribution reports group orders by the person who placed them, so they
 * have to recognise both requester roles. Reading this list rather than naming
 * `ORDER_PORTAL` inline is what keeps a Group Order Portal user's orders from
 * disappearing out of a report that an administrator is relying on.
 */
export const ORDER_CREATOR_ROLES = ["ORDER_PORTAL", "GROUP_ORDER_PORTAL"] as const

export type OrderCreatorRole = (typeof ORDER_CREATOR_ROLES)[number]

export function isOrderCreatorRole(value: unknown): value is OrderCreatorRole {
  return typeof value === "string"
    && ORDER_CREATOR_ROLES.includes(value as OrderCreatorRole)
}
