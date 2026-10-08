/**
 * When a group requester may cancel a branch order of a group order
 * (`plans/OF-GROUP-cancel-pending-group-orders.md`).
 *
 * Only a group order, and only while it is still waiting for approval —
 * including one returned for correction, which is still `PENDING`. Once an
 * approver has approved it, it is no longer the requester's to withdraw.
 *
 * Pure: the server re-reads the order under a lock and claims it on `PENDING`,
 * so this decides what is offered and why a request is refused, never alone
 * whether a cancel lands.
 */

import { CANCELLATION_REASON_MAX_LENGTH } from "@/lib/order-desk-access"

export const GROUP_ORDER_CANCELLABLE_STATUS = "PENDING"

/** One limit for the form and the server schema; the same as the Order Desk's. */
export const GROUP_ORDER_CANCEL_REASON_MAX_LENGTH = CANCELLATION_REASON_MAX_LENGTH

export type GroupOrderCancelRefusal = "NOT_GROUP_ORDER" | "NOT_PENDING"

export type GroupOrderCancelSubject = {
  status?: string | null
  groupOrderId?: number | null
}

export function groupOrderCancelRefusal(order: GroupOrderCancelSubject): GroupOrderCancelRefusal | null {
  if (typeof order.groupOrderId !== "number" || order.groupOrderId <= 0) return "NOT_GROUP_ORDER"
  if (String(order.status ?? "").trim().toUpperCase() !== GROUP_ORDER_CANCELLABLE_STATUS) return "NOT_PENDING"
  return null
}

/** The status test alone, for a screen that already knows the order is a group order. */
export function isCancellableGroupOrderStatus(status: string | null | undefined): boolean {
  return String(status ?? "").trim().toUpperCase() === GROUP_ORDER_CANCELLABLE_STATUS
}

export const GROUP_ORDER_NOT_PENDING_MESSAGE =
  "Only an order that has not been approved yet can be cancelled."

export const GROUP_ORDER_NOTHING_TO_CANCEL_MESSAGE =
  "None of this group order's branch orders is still waiting for approval."
