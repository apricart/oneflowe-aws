/**
 * The multi-branch requester role, named locally rather than imported from
 * `lib/server/multi-branch-scope.ts`: that module is `server-only` and pulls in
 * the database, and this one has to stay importable from a client component —
 * the same reason `lib/fulfillment-token-access.ts` names its roles inline.
 */
const GROUP_ORDER_PORTAL_ROLE = "GROUP_ORDER_PORTAL"

/**
 * Whose contact details a single-order read may carry.
 *
 * The order detail names the person who raised the order and, alongside the
 * name, their email, phone and employee id. For every role that has always
 * received them — an administrator reviewing a branch, a requester looking at
 * its own order — that is unchanged.
 *
 * The Group Order Portal requester is the exception, and only when reading an
 * order somebody else raised. Its reach is a set of branches rather than one,
 * so handing it the contact row of every employee in every assigned branch
 * would turn a read of *orders* into a directory of *people*. It keeps the
 * display name, which is what "who raised this" actually needs.
 *
 * Deliberately keyed on the viewer, never on the order: an order is not more or
 * less sensitive for having come from a group submission, and a rule written
 * the other way round would change what an administrator sees.
 */
export type OrderCreatorContactViewer = {
  role: string | null | undefined
  viewerUserId: string | null | undefined
  orderCreatedByUserId: string | null | undefined
}

/** The contact fields this module governs. Structural, so it stays DB-free. */
export type OrderCreatorContact = {
  creatorEmail: string | null
  creatorPhone: string | null
  creatorEmployeeId: string | null
}

export function canViewOrderCreatorContact({
  role,
  viewerUserId,
  orderCreatedByUserId,
}: OrderCreatorContactViewer): boolean {
  if (role !== GROUP_ORDER_PORTAL_ROLE) return true
  return Boolean(viewerUserId) && viewerUserId === orderCreatedByUserId
}

/**
 * Return the order with its creator contact fields blanked when the viewer may
 * not see them. The name is left in place, and the object is returned unchanged
 * for every viewer that may see them, so no existing response shape shifts —
 * the fields are nulled, never dropped, because clients read them by key.
 */
export function applyOrderCreatorContactVisibility<T extends OrderCreatorContact>(
  order: T,
  viewer: OrderCreatorContactViewer,
): T {
  if (canViewOrderCreatorContact(viewer)) return order
  return { ...order, creatorEmail: null, creatorPhone: null, creatorEmployeeId: null }
}
