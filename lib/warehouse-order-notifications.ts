import { z } from "zod"

import { WAREHOUSE_HOME } from "@/lib/warehouse-access"
import { isWarehouseWorkStatus } from "@/lib/warehouse-orders"

/**
 * What the warehouse is told about the orders of the branches it serves, and
 * how it is worded. Pure: the server decides who receives a notice and when;
 * this decides what it is called and what it says.
 * See plans/OF-WAREHOUSE-order-stage-notifications.md.
 *
 * Every order stage is here **except the delivery stages** (In process, Out for
 * delivery, Delivered): the warehouse records those itself, so no warehouse
 * user is told about them.
 *
 * A notice names the order, its organization and branch, and the stage — never
 * an amount, a person or free text (a rejection reason, a correction comment, a
 * cancellation reason), because the warehouse's reads name no one.
 */

export const WAREHOUSE_ORDER_EVENTS = [
  "CREATED",
  "EDITED",
  "RETURNED",
  "RESUBMITTED",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "REFUNDED",
  "FULFILLED",
] as const

export type WarehouseOrderEvent = (typeof WAREHOUSE_ORDER_EVENTS)[number]

export type WarehouseOrderTemplate = `WAREHOUSE_ORDER_${WarehouseOrderEvent}`

/** The `notifications.target_role` and `email_outbox.recipient_role` of every warehouse notice. */
export const WAREHOUSE_NOTIFICATION_ROLE = "WAREHOUSE" as const

/**
 * Events that can happen more than once on one order. Their event key must name
 * the occurrence (edit time, correction request, refund), or the unique key of
 * the first would silently swallow the second.
 */
export const RECURRING_WAREHOUSE_ORDER_EVENTS: readonly WarehouseOrderEvent[] = ["EDITED", "RETURNED", "RESUBMITTED", "REFUNDED"]

export function warehouseOrderTemplate(event: WarehouseOrderEvent): WarehouseOrderTemplate {
  return `WAREHOUSE_ORDER_${event}`
}

export function isWarehouseOrderTemplate(value: unknown): value is WarehouseOrderTemplate {
  return typeof value === "string"
    && value.startsWith("WAREHOUSE_ORDER_")
    && (WAREHOUSE_ORDER_EVENTS as readonly string[]).includes(value.slice("WAREHOUSE_ORDER_".length))
}

export function warehouseOrderEventOf(template: WarehouseOrderTemplate): WarehouseOrderEvent {
  return template.slice("WAREHOUSE_ORDER_".length) as WarehouseOrderEvent
}

/** One recipient's key for one event on one order. Refuses a recurring event with no occurrence. */
export function warehouseOrderEventKey(input: {
  event: WarehouseOrderEvent
  orderId: number
  recipientUserId: string
  occurrence?: string | number | null
}): string {
  const recurring = RECURRING_WAREHOUSE_ORDER_EVENTS.includes(input.event)
  const occurrence = input.occurrence === undefined || input.occurrence === null ? "" : String(input.occurrence)
  if (recurring && occurrence === "") throw new Error(`WAREHOUSE_NOTIFICATION_OCCURRENCE_REQUIRED:${input.event}`)
  const parts = [warehouseOrderTemplate(input.event), String(input.orderId)]
  if (recurring) parts.push(occurrence)
  parts.push(input.recipientUserId)
  return parts.join(":")
}

/** What a notice and its email carry. Nothing else is ever stored or sent. */
export type WarehouseOrderPayload = {
  orderId: number
  tid: string
  organizationName: string
  branchName: string
  /** CREATED only: the order was approved at creation, so it is already the warehouse's work. */
  approvedAtCreation?: boolean
}

export function parseWarehouseOrderPayload(value: unknown): WarehouseOrderPayload | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  const orderId = Number(raw.orderId)
  if (
    !Number.isInteger(orderId) || orderId <= 0
    || typeof raw.tid !== "string" || raw.tid === ""
    || typeof raw.organizationName !== "string"
    || typeof raw.branchName !== "string"
  ) return null
  return {
    orderId,
    tid: raw.tid,
    organizationName: raw.organizationName,
    branchName: raw.branchName,
    approvedAtCreation: raw.approvedAtCreation === true,
  }
}

export type WarehouseOrderCopy = {
  title: string
  message: string
  subject: string
  intro: string
  /** The email's heading colour. */
  accent: string
  /** Whether the order is now the warehouse's work, so the notice can open its queue. */
  opensQueue: boolean
}

const AMBER = "#d97706"
const GREEN = "#059669"
const RED = "#dc2626"
const SLATE = "#475569"
const INDIGO = "#4f46e5"

export function warehouseOrderCopy(event: WarehouseOrderEvent, payload: WarehouseOrderPayload): WarehouseOrderCopy {
  const where = `${payload.branchName} · ${payload.organizationName}`
  const order = `Order ${payload.tid}`
  switch (event) {
    case "CREATED":
      return payload.approvedAtCreation
        ? {
          title: "New order ready to pick",
          message: `${order} (${where}) was placed and approved at creation.`,
          subject: `${order} was placed and is ready to pick`,
          intro: "A new order was placed and approved automatically under its organization's policy. It is in your queue.",
          accent: GREEN,
          opensQueue: true,
        }
        : {
          title: "New order awaiting approval",
          message: `${order} (${where}) was placed and is awaiting approval.`,
          subject: `${order} was placed and is awaiting approval`,
          intro: "A new order was placed. It reaches your queue once it is approved.",
          accent: AMBER,
          opensQueue: false,
        }
    case "EDITED":
      return {
        title: "Pending order edited",
        message: `${order} (${where}) was edited while awaiting approval.`,
        subject: `${order} was edited`,
        intro: "A pending order's lines were changed. It is still awaiting approval.",
        accent: SLATE,
        opensQueue: false,
      }
    case "RETURNED":
      return {
        title: "Order returned for correction",
        message: `${order} (${where}) was returned to the requester for correction.`,
        subject: `${order} was returned for correction`,
        intro: "An approver sent a pending order back to the requester for correction.",
        accent: AMBER,
        opensQueue: false,
      }
    case "RESUBMITTED":
      return {
        title: "Corrected order resubmitted",
        message: `${order} (${where}) was corrected and resubmitted for approval.`,
        subject: `${order} was resubmitted for approval`,
        intro: "A returned order was corrected and resubmitted. It is awaiting approval again.",
        accent: AMBER,
        opensQueue: false,
      }
    case "APPROVED":
      return {
        title: "Order approved — ready to pick",
        message: `${order} (${where}) was approved and is in your queue.`,
        subject: `${order} was approved and is ready to pick`,
        intro: "An order was approved. It is now in your queue to pick and dispatch.",
        accent: GREEN,
        opensQueue: true,
      }
    case "REJECTED":
      return {
        title: "Order rejected",
        message: `${order} (${where}) was rejected and will not be fulfilled.`,
        subject: `${order} was rejected`,
        intro: "A pending order was rejected. Nothing needs to be picked for it.",
        accent: RED,
        opensQueue: false,
      }
    case "CANCELLED":
      return {
        title: "Order cancelled",
        message: `${order} (${where}) was cancelled and will not be fulfilled.`,
        subject: `${order} was cancelled`,
        intro: "An order was cancelled. Do not pick or dispatch it.",
        accent: RED,
        opensQueue: false,
      }
    case "REFUNDED":
      return {
        title: "Refund approved",
        message: `A refund on ${order} (${where}) was approved.`,
        subject: `A refund on ${order} was approved`,
        intro: "Super Admin approved a refund on an order.",
        accent: INDIGO,
        opensQueue: false,
      }
    case "FULFILLED":
      return {
        title: "Order fulfilled",
        message: `${order} (${where}) was fulfilled — receipt acknowledged.`,
        subject: `${order} was fulfilled`,
        intro: "An order you delivered was fulfilled: its receipt was acknowledged.",
        accent: GREEN,
        opensQueue: true,
      }
  }
}

/** Where a notice may take the warehouse: its order queue, only for an order that is its work. */
export function warehouseOrderLink(event: WarehouseOrderEvent, payload: WarehouseOrderPayload): string | null {
  return warehouseOrderCopy(event, payload).opensQueue ? `${WAREHOUSE_HOME}#orders` : null
}

// ---------------------------------------------------------------------------
// The warehouse's notification list (GET / PATCH /api/v1/warehouse/notifications)
// ---------------------------------------------------------------------------

/** How many notices the bell lists, newest first. */
export const WAREHOUSE_NOTIFICATION_LIST_LIMIT = 30

/** The bell's heading for each event; the stored message carries the detail. */
export const WAREHOUSE_NOTIFICATION_TITLES: Record<WarehouseOrderEvent, string> = {
  CREATED: "New order placed",
  EDITED: "Pending order edited",
  RETURNED: "Order returned for correction",
  RESUBMITTED: "Corrected order resubmitted",
  APPROVED: "Order approved — ready to pick",
  REJECTED: "Order rejected",
  CANCELLED: "Order cancelled",
  REFUNDED: "Refund approved",
  FULFILLED: "Order fulfilled",
}

/** The only change a warehouse user may make to its notices: mark them all read. */
export const warehouseNotificationActionSchema = z.object({ action: z.literal("mark-all-read") }).strict()

export type WarehouseNotificationItem = {
  id: number
  event: WarehouseOrderEvent
  title: string
  message: string
  createdAt: string | null
  read: boolean
  /** The order queue, only while the order is the warehouse's work; otherwise null. */
  href: string | null
}

/**
 * One stored notice as the bell shows it. The link is decided by the order's
 * status **now**, not when the notice was written: an order that was approved
 * and later cancelled no longer opens the queue, where it would read as 404.
 */
export function toWarehouseNotificationItem(row: {
  id: number
  type: string
  message: string
  createdAt: Date | null
  readAt: Date | null
  orderStatus: string | null
}): WarehouseNotificationItem | null {
  if (!isWarehouseOrderTemplate(row.type)) return null
  const event = warehouseOrderEventOf(row.type)
  return {
    id: row.id,
    event,
    title: WAREHOUSE_NOTIFICATION_TITLES[event],
    message: row.message,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    read: row.readAt !== null,
    href: row.orderStatus && isWarehouseWorkStatus(row.orderStatus) ? `${WAREHOUSE_HOME}#orders` : null,
  }
}
