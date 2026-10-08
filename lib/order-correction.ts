/**
 * Returning a pending order to its requesters for correction, and sending it
 * back for approval. See plans/OF-ORDER-RETURN-for-correction.md.
 *
 * A returned order is still `PENDING`. Its budget hold, quantity hold and stock
 * reservation stay exactly where they were, so nothing that reads money by
 * status has to know this state exists. What changes is who holds the order:
 * while `returnedForCorrectionAt` is set it is with the requesters, who may
 * edit it (the ordinary pending edit) and resubmit it; the approver may not
 * approve it until they have, but may still reject it.
 *
 * Pure: the transaction, the locks and the authorization live in
 * `lib/server/order-correction.ts`. This file is the one statement of which
 * transitions are open from which state, shared by the server and the UI.
 */

/** The upper bound on the approver's comment and the requester's reply. */
export const ORDER_CORRECTION_TEXT_MAX_LENGTH = 1000

/**
 * How a round closes. An open round has no resolution. `CANCELLED` closes a
 * returned Order Desk order the desk withdrew instead of resubmitting.
 */
export const ORDER_CORRECTION_RESOLUTIONS = ["RESUBMITTED", "REJECTED", "CANCELLED"] as const
export type OrderCorrectionResolution = (typeof ORDER_CORRECTION_RESOLUTIONS)[number]

/** Audit actions, named once so the trail and its tests cannot drift apart. */
export const ORDER_RETURNED_FOR_CORRECTION_ACTION = "ORDER_RETURNED_FOR_CORRECTION"
export const ORDER_RESUBMITTED_ACTION = "ORDER_RESUBMITTED"

export type OrderCorrectionState = {
  status?: string | null
  returnedForCorrectionAt?: Date | string | null
}

function isPendingStatus(status: unknown): boolean {
  return String(status ?? "").trim().toUpperCase() === "PENDING"
}

function hasOpenCorrection(order: OrderCorrectionState): boolean {
  const value = order.returnedForCorrectionAt
  return value !== null && value !== undefined && value !== ""
}

/** With the requesters, waiting for them to correct and resubmit it. */
export function isAwaitingCorrection(order: OrderCorrectionState): boolean {
  return isPendingStatus(order.status) && hasOpenCorrection(order)
}

/** With the approver: pending, and not sent back. The only state approval accepts. */
export function isAwaitingApproval(order: OrderCorrectionState): boolean {
  return isPendingStatus(order.status) && !hasOpenCorrection(order)
}

export type OrderCorrectionRefusal = "not-pending" | "already-returned" | "not-returned"

/** Why an approver may not return this order now, or null when they may. */
export function returnForCorrectionRefusal(order: OrderCorrectionState): OrderCorrectionRefusal | null {
  if (!isPendingStatus(order.status)) return "not-pending"
  if (hasOpenCorrection(order)) return "already-returned"
  return null
}

/** Why a requester may not resubmit this order now, or null when they may. */
export function resubmissionRefusal(order: OrderCorrectionState): OrderCorrectionRefusal | null {
  if (!isPendingStatus(order.status)) return "not-pending"
  if (!hasOpenCorrection(order)) return "not-returned"
  return null
}

export function orderCorrectionRefusalMessage(
  refusal: OrderCorrectionRefusal,
  status: string | null | undefined,
): string {
  switch (refusal) {
    case "already-returned":
      return "This order has already been returned for correction"
    case "not-returned":
      return "This order is not awaiting correction"
    default:
      return `Only pending orders can be returned or resubmitted. This order is ${String(status ?? "unknown")}.`
  }
}

/** A blank reply is no reply. */
export function normalizeCorrectionNote(note: string | null | undefined): string | null {
  const trimmed = typeof note === "string" ? note.trim() : ""
  return trimmed.length > 0 ? trimmed : null
}

/**
 * The notification key for one round.
 *
 * The other order notifications are keyed `template:order:recipient`, which is
 * right for events that happen once per order. A return and a resubmission can
 * happen many times on one order, so the round is part of the key; without it
 * the second round's notices would collide with the first's and be dropped.
 */
export function correctionNotificationEventKey(
  template: string,
  orderId: number,
  correctionRequestId: number,
  recipientUserId: string,
): string {
  return `${template}:${orderId}:r${correctionRequestId}:${recipientUserId}`
}
