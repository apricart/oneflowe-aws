import { karachiDay } from "@/lib/delivery-sla"

/** Assignment statuses that still need delivery work today. */
export const OPEN_ASSIGNMENT_STATUSES = new Set([
  "ASSIGNED",
  "OUT_FOR_DELIVERY",
  "POD_SUBMITTED",
  "POD_REJECTED",
  "POD_APPROVED",
  "FULFILLMENT_PENDING",
])

/** Rider finished the stop (POD approved or fulfilment done). */
export const DELIVERED_ASSIGNMENT_STATUSES = new Set([
  "POD_APPROVED",
  "FULFILLMENT_PENDING",
  "FULFILLMENT_COMPLETED",
])

export function isAssignmentDelivered(status: string): boolean {
  return DELIVERED_ASSIGNMENT_STATUSES.has(status)
}

export function isAssignmentOpen(status: string): boolean {
  return OPEN_ASSIGNMENT_STATUSES.has(status) && status !== "FULFILLMENT_COMPLETED"
}

/**
 * Service day for an assignment = Karachi calendar day of `assignedAt`.
 * Deliveries are expected the same day.
 */
export function assignmentServiceDay(assignedAt: Date | string): string {
  return karachiDay(assignedAt instanceof Date ? assignedAt : new Date(assignedAt))
}

/** Still needs a same-day delivery (not yet POD-approved / completed). */
const NEEDS_DELIVERY = new Set([
  "ASSIGNED",
  "OUT_FOR_DELIVERY",
  "POD_SUBMITTED",
  "POD_REJECTED",
])

/** True when the stop was assigned before today (Karachi) and is still undelivered. */
export function isAssignmentOverdue(
  assignedAt: Date | string,
  status: string,
  now: Date = new Date(),
): boolean {
  if (!NEEDS_DELIVERY.has(status)) return false
  return assignmentServiceDay(assignedAt) < karachiDay(now)
}

/**
 * Include on today's planner / track map:
 * - anything assigned today (open or delivered flags), or
 * - overdue undelivered carry-over from an earlier day.
 */
export function includeOnTodayRoute(
  assignedAt: Date | string,
  status: string,
  now: Date = new Date(),
): boolean {
  const today = karachiDay(now)
  const day = assignmentServiceDay(assignedAt)
  if (day === today) return true
  return isAssignmentOverdue(assignedAt, status, now)
}
