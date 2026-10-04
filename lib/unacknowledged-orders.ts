/**
 * The Order Portal's "Unacknowledged Orders" tab
 * (plans/OF-ORDERS-unacknowledged-delivery-ordering-block.md).
 *
 * Pure. Which orders the tab lists, in what order, and what each row can do.
 * An order is listed by the very rule the ordering block counts with —
 * `isUnacknowledgedDelivery`, i.e. APPROVED and DELIVERED — so the tab and the
 * popup cannot disagree about what is holding the branch up.
 *
 * Nothing here decides who may see or send a token: the orders list already
 * nulls `approvalToken` for anyone `canViewFulfillmentToken` refuses, and the
 * send-token-email route checks again. A row without a token is simply one the
 * viewer cannot hand over.
 */
import { isUnacknowledgedDelivery } from "@/lib/unacknowledged-delivery-block"

export const UNACKNOWLEDGED_ORDERS_TAB_LABEL = "Unacknowledged Orders"

/**
 * The approved orders the tab reads from. Only APPROVED orders can be
 * unacknowledged deliveries, so asking for them alone keeps a long history of
 * fulfilled orders from pushing an old delivery past the page limit.
 */
export const UNACKNOWLEDGED_ORDERS_SOURCE_URL = "/api/v1/orders?status=approved&limit=500"

export type UnacknowledgedOrderSource = {
  id: number
  status?: string | null
  fulfillmentStatus?: string | null
  deliveredAt?: string | null
  createdAt?: string | null
  approvalToken?: string | null
  /** Set once the token has been emailed to admin operations; it is sent once. */
  tokenHandoffAt?: string | null
}

const timeOf = (value?: string | null): number => {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

/**
 * The orders awaiting acknowledgement, longest-waiting first: by delivery
 * time, then by when they were raised, then by id so the order is stable.
 */
export function selectUnacknowledgedOrders<T extends UnacknowledgedOrderSource>(
  orders: readonly T[] | null | undefined,
): T[] {
  if (!Array.isArray(orders)) return []
  return orders
    .filter((order) => isUnacknowledgedDelivery(order))
    .sort((left, right) =>
      timeOf(left.deliveredAt) - timeOf(right.deliveredAt)
      || timeOf(left.createdAt) - timeOf(right.createdAt)
      || left.id - right.id)
}

/** Whether this viewer can send the order's token from the tab. */
export function canSendTokenFromTab(order: UnacknowledgedOrderSource): boolean {
  return typeof order.approvalToken === "string" && order.approvalToken.trim().length > 0
}

/** Said in place of the token when the viewer is not the one who can hand it over. */
export const TOKEN_HELD_BY_RAISER_NOTE = "Only the person who raised this order can see and send its token."

/** How the admin orders screen names the same set of orders. */
export const DELIVERED_UNFULFILLED_LABEL = "Delivered · Unfulfilled"

/**
 * `GET /api/v1/orders?delivery=unacknowledged` narrows the list to the
 * delivered-but-unacknowledged orders. It is the only accepted value; anything
 * else is refused rather than ignored, since ignoring it would return more
 * rows than the caller asked for.
 */
export const ORDER_DELIVERY_FILTER_UNACKNOWLEDGED = "unacknowledged" as const
export type OrderDeliveryFilter = typeof ORDER_DELIVERY_FILTER_UNACKNOWLEDGED

export type OrderDeliveryFilterParse =
  | { ok: true; filter: OrderDeliveryFilter | null }
  | { ok: false; message: string }

export function parseOrderDeliveryFilter(raw: string | null | undefined): OrderDeliveryFilterParse {
  if (raw === null || raw === undefined || raw.trim() === "") return { ok: true, filter: null }
  return raw.trim().toLowerCase() === ORDER_DELIVERY_FILTER_UNACKNOWLEDGED
    ? { ok: true, filter: ORDER_DELIVERY_FILTER_UNACKNOWLEDGED }
    : { ok: false, message: `delivery must be "${ORDER_DELIVERY_FILTER_UNACKNOWLEDGED}"` }
}

/**
 * What the Action column on the admin orders table offers for one row.
 *
 * - `fulfil-with-token`: Super Admin completes the order through
 *   `POST /api/v1/orders/[id]/fulfill`, which re-verifies the token.
 * - `send-token`: an approver who was handed the token emails it to admin
 *   operations through `POST /api/v1/orders/[id]/send-token-email`, which
 *   settles the order once it is delivered. That route does not admit
 *   Super Admin, which is why the two never overlap.
 *
 * Only an active (APPROVED) order with a token the server chose to return
 * gets an action; the routes check both again.
 */
export type OrderRowFulfilmentAction = "fulfil-with-token" | "send-token"

export function orderRowFulfilmentAction({
  canFulfilWithToken,
  status,
  approvalToken,
}: {
  canFulfilWithToken: boolean
  status?: string | null
  approvalToken?: string | null
}): OrderRowFulfilmentAction | null {
  if (String(status ?? "").trim().toUpperCase() !== "APPROVED") return null
  if (!canSendTokenFromTab({ id: 0, approvalToken })) return null
  return canFulfilWithToken ? "fulfil-with-token" : "send-token"
}
