/**
 * The vocabulary and the state machine of a support thread.
 *
 * A support thread is a conversation between one client organization and
 * Apricart about an invoice, an order, or anything else the client needs to
 * raise. This module is pure: it holds no database access and no session
 * handling, so every rule in it is unit-testable and is shared by the server,
 * the route handlers and the UI rather than being restated in each.
 *
 * Who may *read* a thread is a separate concern and lives in
 * `lib/support-access.ts`.
 */

/** The two parties to every thread. Apricart is always one of them. */
export const SUPPORT_SIDES = ["CUSTOMER", "APRICART"] as const
export type SupportSide = (typeof SUPPORT_SIDES)[number]

export const SUPPORT_CATEGORIES = [
  "INVOICE",
  "ORDER",
  "DELIVERY",
  "PRODUCT",
  "BILLING",
  "OTHER",
] as const
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number]

export const SUPPORT_CATEGORY_LABELS: Record<SupportCategory, string> = {
  INVOICE: "Invoice",
  ORDER: "Order",
  DELIVERY: "Delivery",
  PRODUCT: "Product",
  BILLING: "Billing & payment",
  OTHER: "Other",
}

export const SUPPORT_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number]

export const SUPPORT_PRIORITY_LABELS: Record<SupportPriority, string> = {
  LOW: "Low",
  NORMAL: "Normal",
  HIGH: "High",
  URGENT: "Urgent",
}

/**
 * OPEN              — the customer wrote last; Apricart owes a reply.
 * AWAITING_CUSTOMER — Apricart wrote last; the client owes a reply.
 * RESOLVED          — settled, but reopenable by either side.
 * CLOSED            — terminal. Accepts no messages. Only Apricart reopens it.
 */
export const SUPPORT_STATUSES = ["OPEN", "AWAITING_CUSTOMER", "RESOLVED", "CLOSED"] as const
export type SupportStatus = (typeof SUPPORT_STATUSES)[number]

export const SUPPORT_STATUS_LABELS: Record<SupportStatus, string> = {
  OPEN: "Open",
  AWAITING_CUSTOMER: "Awaiting your reply",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
}

/** The same statuses read from Apricart's side of the conversation. */
export const SUPPORT_STATUS_LABELS_APRICART: Record<SupportStatus, string> = {
  OPEN: "Needs a reply",
  AWAITING_CUSTOMER: "Awaiting customer",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
}

export function isSupportCategory(value: unknown): value is SupportCategory {
  return typeof value === "string" && SUPPORT_CATEGORIES.includes(value as SupportCategory)
}

export function isSupportPriority(value: unknown): value is SupportPriority {
  return typeof value === "string" && SUPPORT_PRIORITIES.includes(value as SupportPriority)
}

export function isSupportStatus(value: unknown): value is SupportStatus {
  return typeof value === "string" && SUPPORT_STATUSES.includes(value as SupportStatus)
}

export function isSupportSide(value: unknown): value is SupportSide {
  return typeof value === "string" && SUPPORT_SIDES.includes(value as SupportSide)
}

/**
 * Which side of the conversation a role speaks for.
 *
 * Apricart operates this platform as `SUPER_ADMIN`; every other role is a
 * client of it. There is no third side, so this is deliberately total rather
 * than returning null for an unknown role — an unrecognised role is a customer,
 * which is the side that grants nothing.
 */
export function supportSideForRole(role: string | null | undefined): SupportSide {
  return role === "SUPER_ADMIN" ? "APRICART" : "CUSTOMER"
}

/** A closed thread is finished: nobody adds to it, on either side. */
export function isTerminalSupportStatus(status: SupportStatus): boolean {
  return status === "CLOSED"
}

/**
 * The status a thread lands in once `side` posts a message to it.
 *
 * Posting is what moves a thread, not an explicit status change: a customer
 * writing puts the ball back with Apricart, and Apricart writing puts it back
 * with the customer. Replying to a resolved thread reopens it, which is what
 * "the problem came back" means in practice.
 */
export function nextSupportStatusAfterMessage(
  current: SupportStatus,
  side: SupportSide,
): SupportStatus {
  if (isTerminalSupportStatus(current)) return current
  return side === "APRICART" ? "AWAITING_CUSTOMER" : "OPEN"
}

export type SupportTransitionInput = {
  from: SupportStatus
  to: SupportStatus
  side: SupportSide
}

export type SupportTransitionResult = { ok: true } | { ok: false; reason: string }

/**
 * May `side` move a thread from one status to another by hand?
 *
 * Only the settling statuses are set by hand — `OPEN` and `AWAITING_CUSTOMER`
 * are consequences of somebody writing, never a button. Both sides may resolve
 * a thread and both may reopen a resolved one; closing, and reopening something
 * closed, belong to Apricart, because a closed thread is the platform's record
 * that the matter is finished.
 */
export function canTransitionSupportStatus(
  input: SupportTransitionInput,
): SupportTransitionResult {
  const { from, to, side } = input

  if (from === to) {
    return { ok: false, reason: `This request is already ${SUPPORT_STATUS_LABELS[to].toLowerCase()}.` }
  }

  if (to === "OPEN" || to === "AWAITING_CUSTOMER") {
    // Reopening is the only hand-made move into a live status, and it always
    // lands on OPEN — the reopener is asking Apricart to look again.
    if (to === "AWAITING_CUSTOMER") {
      return { ok: false, reason: "A request moves to awaiting-reply by someone posting a message." }
    }
    if (from === "RESOLVED") return { ok: true }
    if (from === "CLOSED") {
      return side === "APRICART"
        ? { ok: true }
        : { ok: false, reason: "A closed request can only be reopened by the Apricart team." }
    }
    return { ok: false, reason: "A request moves to open by someone posting a message." }
  }

  if (to === "RESOLVED") {
    if (isTerminalSupportStatus(from)) {
      return { ok: false, reason: "A closed request cannot be resolved. Reopen it first." }
    }
    return { ok: true }
  }

  // to === "CLOSED"
  return side === "APRICART"
    ? { ok: true }
    : { ok: false, reason: "Only the Apricart team can close a request." }
}

/**
 * The human reference for a thread, e.g. `SUP-000123`.
 *
 * Derived from the primary key rather than stored, so it cannot drift from the
 * row it names. Padded to six digits for legibility and allowed to grow past
 * that rather than truncating.
 */
export function supportThreadReference(id: number): string {
  if (!Number.isInteger(id) || id <= 0) return "SUP-------"
  return `SUP-${String(id).padStart(6, "0")}`
}

/** Parses `SUP-000123`, or a bare number, back to an id. Null when it is neither. */
export function parseSupportThreadReference(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null
  const match = /^\s*(?:SUP-)?0*(\d{1,9})\s*$/i.exec(value)
  if (!match) return null
  const id = Number(match[1])
  return Number.isInteger(id) && id > 0 ? id : null
}

export const SUPPORT_SUBJECT_MAX_LENGTH = 200
export const SUPPORT_MESSAGE_MAX_LENGTH = 5000
export const SUPPORT_MAX_ATTACHMENTS_PER_MESSAGE = 5
