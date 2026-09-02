import { and, desc, eq, inArray } from "drizzle-orm"
import { db } from "@/lib/db"
import { auditLogs, users } from "@/db/schema"
import { getReceiptUserDisplayName } from "@/lib/receipt-user"

/**
 * The people an invoice names: who raised the order, who approved it, and who
 * handed it to admin operations for fulfilment.
 *
 * The preview and the PDF download both resolve these here so the two can
 * never name different people for the same order. The ids come from the order
 * row the caller has already been authorized against, so this reads no record
 * the caller could not already see.
 */
export interface InvoiceParticipants {
  placedByName: string
  placedByPhone: string | null
  approvedByName: string
  fulfilledByName: string
}

export interface InvoiceParticipantIds {
  id: number
  createdByUserId: string
  approvedByUserId: string | null
  /** The order's own status, which decides whether it has a fulfiller at all. */
  status?: string | null
  /** Set by the fulfilment transition; the most direct evidence of settlement. */
  fulfilledAt?: Date | string | null
}

/**
 * An order can reach fulfilment with nobody recorded as having handed its
 * token over. Such an invoice reports no fulfiller rather than inventing one,
 * the same way an unapproved order reports no approver.
 */
const NO_PARTICIPANT = "N/A"
const UNRESOLVED_PARTICIPANT = "Unknown"

/** Written by both token hand-off endpoints, single-order and group alike. */
const TOKEN_EMAIL_AUDIT_ACTION = "SEND_ORDER_TOKEN_EMAIL"

/**
 * The statuses an order only reaches by being settled. A refund is applied to
 * an order that was already fulfilled, so it keeps its fulfiller.
 */
const FULFILLED_STATUSES = new Set([
  "FULFILLED",
  "PARTIAL",
  "PARTIALLY_FULFILLED",
  "REFUNDED",
])

/**
 * Whether the order has actually been fulfilled.
 *
 * An order that is still pending or merely approved has no fulfiller yet, and
 * the invoice must not name one: a hand-off that was attempted but did not
 * settle the order, or an approver standing in for a hand-off that never
 * happened, would otherwise be printed as the person who fulfilled it.
 *
 * `fulfilledAt` is the transition's own stamp and settles the question on its
 * own; the status set covers rows written before that column was populated.
 */
function hasBeenFulfilled(order: InvoiceParticipantIds): boolean {
  if (order.fulfilledAt) return true
  return FULFILLED_STATUSES.has(String(order.status ?? "").trim().toUpperCase())
}

/**
 * Who sent the fulfilment token to admin operations.
 *
 * `orders.fulfilled_by_user_id` is deliberately not consulted: it records
 * whoever moved the order to FULFILLED, which is the administrator who
 * redeemed the token rather than the person who handed it over. Naming that
 * administrator on every invoice says nothing about who fulfilled the order.
 *
 * The hand-off itself is in the audit trail, written by both token endpoints,
 * so the invoice reads it from there and stays right for orders settled before
 * this was noticed. The most recent hand-off wins: a token that was re-sent
 * supersedes the one before it, and it is the message that reached the
 * administrator.
 */
async function findTokenHandoffSenderId(orderId: number): Promise<string | null> {
  const [handoff] = await db
    .select({ userId: auditLogs.userId })
    .from(auditLogs)
    .where(and(
      eq(auditLogs.entity, "ORDER"),
      eq(auditLogs.entityId, String(orderId)),
      eq(auditLogs.action, TOKEN_EMAIL_AUDIT_ACTION),
    ))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(1)

  return handoff?.userId ?? null
}

export async function loadInvoiceParticipants(
  order: InvoiceParticipantIds,
): Promise<InvoiceParticipants> {
  /*
   * The hand-off is what the invoice reports, but only once the order has
   * actually been fulfilled. An unfulfilled order reports no fulfiller at all —
   * neither a hand-off that failed to settle it nor the approver standing in
   * for one that never happened.
   *
   * For a fulfilled order a token shared outside the app leaves no record of
   * its sender, so the approver stands in: the plaintext token is issued to
   * them on approval, which makes them the person who hands it to admin
   * operations. The administrator who redeemed it is never named.
   */
  const fulfilled = hasBeenFulfilled(order)
  const handoffSenderId = fulfilled ? await findTokenHandoffSenderId(order.id) : null
  const fulfilledByUserId = fulfilled ? handoffSenderId ?? order.approvedByUserId : null

  const ids = [order.createdByUserId, order.approvedByUserId, fulfilledByUserId]
    .filter((id): id is string => typeof id === "string" && id.length > 0)
  const uniqueIds = [...new Set(ids)]

  const rows = uniqueIds.length > 0
    ? await db
      .select({
        id: users.id,
        fullName: users.fullName,
        firstName: users.firstName,
        lastName: users.lastName,
        username: users.username,
        email: users.email,
        phone: users.phone,
      })
      .from(users)
      .where(inArray(users.id, uniqueIds))
      .limit(uniqueIds.length)
    : []

  const byId = new Map(rows.map((row) => [row.id, row]))
  const creator = byId.get(order.createdByUserId)

  const nameFor = (userId: string | null) =>
    userId
      ? getReceiptUserDisplayName(byId.get(userId), UNRESOLVED_PARTICIPANT)
      : NO_PARTICIPANT

  return {
    placedByName: getReceiptUserDisplayName(creator, UNRESOLVED_PARTICIPANT),
    placedByPhone: creator?.phone || null,
    approvedByName: nameFor(order.approvedByUserId),
    fulfilledByName: nameFor(fulfilledByUserId),
  }
}
