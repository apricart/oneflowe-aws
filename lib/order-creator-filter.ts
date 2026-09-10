import {
  ORDER_CREATOR_ROLES,
  isOrderCreatorRole,
  type OrderCreatorRole,
} from "@/lib/group-order-visibility"

/**
 * Narrowing the order list to the role that *raised* an order.
 *
 * The Group User's workspace separates the orders branch employees placed
 * themselves from the ones a Group Order Portal submission fanned out to their
 * branches. The honest way to express that difference is the creator's role,
 * not `groupOrderId` — a group order is an ordinary order of the branch's, and
 * `CLAUDE.md` forbids keying any query on that column precisely so it cannot
 * fall out of the branch's own figures.
 *
 * Only the two ordering roles are accepted. A role that decides orders rather
 * than raising them would match nothing useful, so it is refused as a mistake
 * rather than answered with an empty list.
 */
export type OrderCreatorFilter =
  | { ok: true; role: OrderCreatorRole | null }
  | { ok: false; message: string }

/**
 * Parse the `createdByRole` query parameter.
 *
 * An absent or empty value means "no filter". An unrecognised value is an
 * error, never a silently dropped filter: this parameter only ever removes
 * rows, so ignoring a malformed one would return more than the caller asked
 * for — the wrong direction for a filter to fail in.
 */
export function parseOrderCreatorRoleFilter(value: unknown): OrderCreatorFilter {
  if (value === null || value === undefined) return { ok: true, role: null }
  if (typeof value !== "string") {
    return { ok: false, message: invalidCreatorRoleMessage() }
  }

  const normalized = value.trim().toUpperCase()
  if (normalized.length === 0) return { ok: true, role: null }
  if (!isOrderCreatorRole(normalized)) {
    return { ok: false, message: invalidCreatorRoleMessage() }
  }

  return { ok: true, role: normalized }
}

function invalidCreatorRoleMessage(): string {
  return `createdByRole must be one of: ${ORDER_CREATOR_ROLES.join(", ")}`
}
