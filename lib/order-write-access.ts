/**
 * Who may write to an order: the branch owns it, not the person who raised it.
 *
 * A requester acts for a branch. `ORDER_PORTAL` acts for exactly one; a
 * `GROUP_ORDER_PORTAL` user acts for the set an administrator assigned it.
 * Either may edit or refund an order **at a branch it is assigned to**,
 * whoever raised it — a group order raised for a branch and an order raised by
 * that branch's own staff spend the same budget and arrive at the same place,
 * so the same people answer for both.
 *
 * Replaces the earlier creator-equality rule, which was doing two jobs at once:
 * proving the actor belonged to the branch, and proving they were accountable
 * for the order. This keeps the first. The second moves to the audit trail —
 * `describeOrderWrite` marks a write made on someone else's order so the caller
 * can record both parties and tell the raiser.
 *
 * Scope is never widened here. The branch set is resolved server-side from the
 * session by the caller, and an **empty set denies everything** rather than
 * falling back to the organization. Tenant equality is asserted explicitly, in
 * both directions: the order's organization must match the actor's, and the
 * order's branch must belong to that same organization.
 */

/** The roles that raise orders, and so may write to one. */
export const ORDER_WRITE_ROLES = ["ORDER_PORTAL", "GROUP_ORDER_PORTAL"] as const

export type OrderWriteRole = (typeof ORDER_WRITE_ROLES)[number]

export function isOrderWriteRole(value: unknown): value is OrderWriteRole {
  return typeof value === "string"
    && ORDER_WRITE_ROLES.includes(value as OrderWriteRole)
}

/**
 * The actor, already resolved from the session.
 *
 * `branchIds` is the whole of the actor's reach: one branch for `ORDER_PORTAL`,
 * the resolved assignment set for `GROUP_ORDER_PORTAL`. Callers must never
 * build it from request input.
 */
export type OrderWriteActor = {
  role: string | null | undefined
  userId: string | null | undefined
  organizationId: number | null | undefined
  branchIds: readonly number[] | null | undefined
}

/** The order, as the database holds it. Structural so this stays DB-free. */
export type OrderWriteSubject = {
  status: string | null | undefined
  createdByUserId: string | null | undefined
  organizationId: number | null | undefined
  branchId: number | null | undefined
  /** The organization the order's branch belongs to, read separately. */
  branchOrganizationId: number | null | undefined
}

function normalizeStatus(status: unknown): string {
  return String(status ?? "").trim().toUpperCase()
}

/**
 * The branch and tenant test both edits and refunds share.
 *
 * Deliberately says nothing about order status — an edit needs `PENDING` and a
 * refund needs the opposite, so each caller adds its own state rule on top.
 */
export function canRequesterActOnOrder(
  actor: OrderWriteActor,
  order: OrderWriteSubject,
): boolean {
  if (!isOrderWriteRole(actor.role)) return false
  if (typeof actor.userId !== "string" || actor.userId.length === 0) return false

  if (typeof actor.organizationId !== "number") return false
  if (actor.organizationId !== order.organizationId) return false
  // The branch must sit in the same tenant as the order, or a branch moved
  // between organizations would carry its orders' access with it.
  if (order.branchOrganizationId !== order.organizationId) return false

  if (typeof order.branchId !== "number") return false
  const branchIds = actor.branchIds ?? []
  // An actor with no assignment reaches nothing. Never read as "all branches".
  if (branchIds.length === 0) return false
  return branchIds.includes(order.branchId)
}

/** An order may be edited while it is still pending, by anyone at its branch. */
export function canRequesterEditOrder(
  actor: OrderWriteActor,
  order: OrderWriteSubject,
): boolean {
  return canRequesterActOnOrder(actor, order)
    && normalizeStatus(order.status) === "PENDING"
}

/**
 * Whether this write lands on an order somebody else raised.
 *
 * Not an authorization decision — `canRequesterActOnOrder` has already made
 * that. This is what the audit row and the raiser's notification key on, which
 * is the whole of what replaced creator equality.
 */
export function describeOrderWrite(
  actor: OrderWriteActor,
  order: OrderWriteSubject,
): { onBehalfOfUserId: string | null; isCrossRequesterWrite: boolean } {
  const raiser = order.createdByUserId
  const isCross = typeof raiser === "string"
    && raiser.length > 0
    && raiser !== actor.userId
  return {
    onBehalfOfUserId: isCross ? raiser : null,
    isCrossRequesterWrite: isCross,
  }
}
