import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  AUTO_APPROVAL_WINDOW_MS,
  STATUS_FLOW,
  buildStatusTimeline,
  canModifyOrder,
  getAutoApprovalCountdown,
  getAutoApproveMeta,
  isTerminalStatus,
  isValidOrderStatus,
} from "./order-utils"

/**
 * The order detail page renders `buildStatusTimeline(order.status, …)` for
 * every order it shows, whatever its status. These cases pin the timeline for
 * each status the database actually holds, not only the four in STATUS_FLOW.
 */

const NOW = new Date("2026-10-06T10:00:00.000Z").getTime()

function stateOf(timeline: ReturnType<typeof buildStatusTimeline>, key: string) {
  return timeline.find((step) => step.key === key)?.state
}

describe("buildStatusTimeline — every stored status", () => {
  it("shows a rejected order as rejected, not as still awaiting review", () => {
    const timeline = buildStatusTimeline("REJECTED")

    expect(timeline.map((step) => step.key)).toEqual(["pending", "rejected"])
    expect(stateOf(timeline, "pending")).toBe("complete")
    expect(stateOf(timeline, "rejected")).toBe("current")
    expect(timeline.every((step) => step.approvalToken === null)).toBe(true)
  })

  it("never leaves a terminal rejected or cancelled order with a pending step marked current", () => {
    for (const status of ["REJECTED", "rejected", " Rejected ", "CANCELLED", "cancelled"]) {
      const timeline = buildStatusTimeline(status)
      expect(stateOf(timeline, "pending"), status).toBe("complete")
    }
  })

  it("shows a cancelled order as cancelled without naming who cancelled it", () => {
    const timeline = buildStatusTimeline("CANCELLED")

    expect(timeline.map((step) => step.key)).toEqual(["pending", "cancelled"])
    expect(stateOf(timeline, "cancelled")).toBe("current")
    // The Order Desk cancels too, so the copy must not claim Head Office did.
    expect(timeline[1].description).not.toMatch(/head office/i)
  })

  it("is case and whitespace insensitive for the main flow", () => {
    expect(buildStatusTimeline("  APPROVED ")).toEqual(buildStatusTimeline("approved"))
  })

  it("marks every step before the active one complete and every step after it upcoming", () => {
    const timeline = buildStatusTimeline("approved")
    expect(timeline.map((step) => step.state)).toEqual(["complete", "current", "upcoming", "upcoming"])
  })

  it("treats a fulfilled order's own step as complete rather than current", () => {
    const timeline = buildStatusTimeline("FULFILLED")
    expect(timeline.map((step) => step.state)).toEqual(["complete", "complete", "complete", "upcoming"])
  })

  it("keeps the fulfilled step complete when the refund came after fulfilment", () => {
    const timeline = buildStatusTimeline("REFUNDED", "FULFILLED")
    expect(stateOf(timeline, "fulfilled")).toBe("complete")
    expect(stateOf(timeline, "refunded")).toBe("complete")
  })

  it("skips the fulfilled step when the refund came before fulfilment, including when no origin is recorded", () => {
    expect(stateOf(buildStatusTimeline("REFUNDED", "APPROVED"), "fulfilled")).toBe("skipped")
    expect(stateOf(buildStatusTimeline("REFUNDED", null), "fulfilled")).toBe("skipped")
    expect(stateOf(buildStatusTimeline("REFUNDED"), "fulfilled")).toBe("skipped")
  })

  it("labels and highlights a partial refund on a fulfilled order", () => {
    const timeline = buildStatusTimeline("FULFILLED", null, true)
    const refunded = timeline.find((step) => step.key === "refunded")

    expect(refunded?.label).toBe("Partially Refunded")
    expect(refunded?.state).toBe("current")
  })

  it("links the approval token only to an approved step that has been reached", () => {
    expect(buildStatusTimeline("PENDING", null, false, "TOKEN-1").every((step) => step.approvalToken === null)).toBe(true)

    const approved = buildStatusTimeline("APPROVED", null, false, "TOKEN-1")
    expect(approved.find((step) => step.key === "approved")?.approvalToken).toBe("TOKEN-1")
    expect(approved.filter((step) => step.approvalToken).length).toBe(1)

    const fulfilled = buildStatusTimeline("FULFILLED", null, false, "TOKEN-1")
    expect(fulfilled.find((step) => step.key === "approved")?.approvalToken).toBe("TOKEN-1")
  })

  it("does not invent a token when none is supplied", () => {
    const timeline = buildStatusTimeline("APPROVED")
    expect(timeline.find((step) => step.key === "approved")?.approvalToken).toBeNull()
  })

  it("falls back to an all-upcoming flow for a missing status", () => {
    const timeline = buildStatusTimeline("")
    expect(timeline).toHaveLength(STATUS_FLOW.length)
    expect(timeline.every((step) => step.state === "upcoming")).toBe(true)
  })

  it("starts an unrecognised status at the first step", () => {
    const timeline = buildStatusTimeline("SOMETHING_NEW")
    expect(timeline.map((step) => step.state)).toEqual(["current", "upcoming", "upcoming", "upcoming"])
  })
})

describe("getAutoApproveMeta countdown", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const pendingCreatedAgo = (ms: number) => ({ status: "PENDING", createdAt: new Date(NOW - ms).toISOString() })

  it("counts the full window down in hours and minutes", () => {
    expect(getAutoApproveMeta(pendingCreatedAgo(0))?.title).toBe("Auto approval in 2h 0m")
    expect(getAutoApproveMeta(pendingCreatedAgo(30 * 60_000))?.title).toBe("Auto approval in 1h 30m")
  })

  it("drops the hour part under an hour and rounds a partial minute up", () => {
    expect(getAutoApproveMeta(pendingCreatedAgo(AUTO_APPROVAL_WINDOW_MS - 59 * 60_000))?.title)
      .toBe("Auto approval in 59m")
    expect(getAutoApproveMeta(pendingCreatedAgo(AUTO_APPROVAL_WINDOW_MS - 1_000))?.title)
      .toBe("Auto approval in 1m")
  })

  it("reports the approval as queued once the window has elapsed, exactly at the boundary too", () => {
    expect(getAutoApproveMeta(pendingCreatedAgo(AUTO_APPROVAL_WINDOW_MS))?.title).toBe("Auto-approval queued")
    expect(getAutoApproveMeta(pendingCreatedAgo(AUTO_APPROVAL_WINDOW_MS + 1))?.title).toBe("Auto-approval queued")
  })

  it("still produces a countdown for a createdAt in the future (clock skew)", () => {
    const meta = getAutoApproveMeta({ status: "pending", createdAt: new Date(NOW + 10 * 60_000).toISOString() })
    expect(meta?.title).toBe("Auto approval in 2h 10m")
  })

  it("returns nothing for orders that are not pending or are malformed", () => {
    expect(getAutoApproveMeta({ status: "APPROVED", createdAt: new Date(NOW).toISOString() })).toBeNull()
    expect(getAutoApproveMeta({ status: "", createdAt: new Date(NOW).toISOString() })).toBeNull()
    expect(getAutoApproveMeta({ status: "PENDING", createdAt: "" })).toBeNull()
    expect(getAutoApproveMeta({ status: 7 as unknown as string, createdAt: new Date(NOW).toISOString() })).toBeNull()
  })

  it("exposes the title alone through getAutoApprovalCountdown", () => {
    expect(getAutoApprovalCountdown(pendingCreatedAgo(0))).toBe("Auto approval in 2h 0m")
    expect(getAutoApprovalCountdown({ status: "FULFILLED", createdAt: new Date(NOW).toISOString() })).toBeNull()
    expect(getAutoApprovalCountdown(null)).toBeNull()
  })
})

describe("status predicates", () => {
  it("recognises the flow statuses and cancellation", () => {
    for (const status of ["pending", "APPROVED", " fulfilled ", "Refunded", "cancelled"]) {
      expect(isValidOrderStatus(status), status).toBe(true)
    }
    expect(isValidOrderStatus("unknown")).toBe(false)
    expect(isValidOrderStatus("")).toBe(false)
  })

  it("treats fulfilled, refunded and cancelled as terminal and pending as open", () => {
    expect(isTerminalStatus("FULFILLED")).toBe(true)
    expect(isTerminalStatus("refunded")).toBe(true)
    expect(isTerminalStatus("Cancelled")).toBe(true)
    expect(isTerminalStatus("PENDING")).toBe(false)
    expect(isTerminalStatus("")).toBe(false)
  })

  it("only allows modifying a pending order", () => {
    expect(canModifyOrder(" pending ")).toBe(true)
    expect(canModifyOrder("APPROVED")).toBe(false)
    expect(canModifyOrder("")).toBe(false)
  })
})
