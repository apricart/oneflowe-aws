import { describe, expect, it } from "vitest"
import {
  includeOnTodayRoute,
  isAssignmentDelivered,
  isAssignmentOverdue,
} from "@/lib/rider/same-day"

describe("same-day rider assignments", () => {
  const midToday = new Date("2026-10-22T10:00:00.000+05:00")
  const yesterday = new Date("2026-10-21T15:00:00.000+05:00")

  it("flags open assignments from a previous Karachi day as overdue", () => {
    expect(isAssignmentOverdue(yesterday, "ASSIGNED", midToday)).toBe(true)
    expect(isAssignmentOverdue(yesterday, "OUT_FOR_DELIVERY", midToday)).toBe(true)
    expect(isAssignmentOverdue(midToday, "ASSIGNED", midToday)).toBe(false)
    expect(isAssignmentOverdue(yesterday, "POD_APPROVED", midToday)).toBe(false)
    expect(isAssignmentOverdue(yesterday, "FULFILLMENT_COMPLETED", midToday)).toBe(false)
  })

  it("keeps today's assignments and overdue carry-overs on today's route", () => {
    expect(includeOnTodayRoute(midToday, "ASSIGNED", midToday)).toBe(true)
    expect(includeOnTodayRoute(yesterday, "ASSIGNED", midToday)).toBe(true)
    expect(includeOnTodayRoute(yesterday, "FULFILLMENT_COMPLETED", midToday)).toBe(false)
  })

  it("treats POD approved as delivered for map flags", () => {
    expect(isAssignmentDelivered("POD_APPROVED")).toBe(true)
    expect(isAssignmentDelivered("ASSIGNED")).toBe(false)
  })
})
