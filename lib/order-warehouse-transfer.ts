/**
 * Moving one order from one Apricart warehouse to another.
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md (phase 3, as built).
 *
 * An order is fulfilled by the warehouse it names in
 * `orders.fulfillment_warehouse_id`, or — while it names none, which is every
 * order until Super Admin transfers it — by the warehouse accounts whose branch
 * reach covers its branch, exactly as before. A transfer therefore changes only
 * the order it names: the order's branch, its tenant, its approval, budget,
 * invoice and delivery clock are untouched, and so is every other order at that
 * branch.
 *
 * Who works a transferred order is the target warehouse's active operators
 * (`apricart_warehouse_memberships`, `WAREHOUSE_OPERATOR`); the accounts that
 * serve the branch stop seeing it. Executives are not involved: who approves an
 * Order Desk order is still decided by `apricart_executive_assignments`.
 *
 * Pure, so the route, the server module and the page read the same rules.
 */

import { normalizeFulfillmentStatus } from "@/lib/fulfillment-status"

/** Only Super Admin moves an order between warehouses. */
export const ORDER_WAREHOUSE_TRANSFER_ROLES: readonly string[] = ["SUPER_ADMIN"]

export function canTransferOrderWarehouse(role: unknown): boolean {
  return typeof role === "string" && ORDER_WAREHOUSE_TRANSFER_ROLES.includes(role)
}

export const ORDER_WAREHOUSE_TRANSFER_AUDIT_ACTION = "ORDER_WAREHOUSE_TRANSFERRED"

export const ORDER_WAREHOUSE_TRANSFER_REASON_MIN_LENGTH = 3
export const ORDER_WAREHOUSE_TRANSFER_REASON_MAX_LENGTH = 500

/** How many past transfers the order's panel lists. */
export const ORDER_WAREHOUSE_TRANSFER_HISTORY_LIMIT = 20

export type OrderWarehouseTransferRefusal =
  | "not-open"
  | "out-for-delivery"

/**
 * Whether the order may change warehouse now, or why not.
 *
 * Allowed while it is pending, or approved and not yet out for delivery. Once
 * the goods have left a warehouse the order stays where it is, and a rejected,
 * cancelled, refunded or fulfilled order has nothing left to fulfil.
 */
export function orderWarehouseTransferRefusal(order: {
  status: string | null | undefined
  fulfillmentStatus: string | null | undefined
}): OrderWarehouseTransferRefusal | null {
  const status = String(order.status ?? "").trim().toUpperCase()
  if (status !== "PENDING" && status !== "APPROVED") return "not-open"
  const stage = normalizeFulfillmentStatus(order.fulfillmentStatus)
  if (stage === "OUT_FOR_DELIVERY" || stage === "DELIVERED") return "out-for-delivery"
  return null
}

export const ORDER_WAREHOUSE_TRANSFER_REFUSAL_MESSAGES: Record<OrderWarehouseTransferRefusal, string> = {
  "not-open": "Only a pending or approved order can move to another warehouse",
  "out-for-delivery": "This order has left the warehouse — it can no longer move to another one",
}

/**
 * The branch reach and warehouse memberships of one warehouse account. Empty
 * lists mean none, never "all".
 */
export type WarehouseOrderReach = {
  /** Branches it serves, one by one or by city: the orders that name no warehouse. */
  branchIds: readonly number[]
  /** Warehouses it is an active operator of: the orders transferred to them. */
  warehouseIds: readonly number[]
}

export const EMPTY_WAREHOUSE_ORDER_REACH: WarehouseOrderReach = { branchIds: [], warehouseIds: [] }

export function isEmptyWarehouseOrderReach(reach: WarehouseOrderReach): boolean {
  return reach.branchIds.length === 0 && reach.warehouseIds.length === 0
}

/**
 * The one rule for whether an order is a warehouse account's to work: an order
 * transferred to a warehouse belongs to that warehouse's operators only; an
 * order with no warehouse belongs to whoever serves its branch.
 */
export function isOrderInWarehouseOrderReach(
  order: { branchId: number; fulfillmentWarehouseId: number | null },
  reach: WarehouseOrderReach,
): boolean {
  if (order.fulfillmentWarehouseId !== null) return reach.warehouseIds.includes(order.fulfillmentWarehouseId)
  return reach.branchIds.includes(order.branchId)
}
