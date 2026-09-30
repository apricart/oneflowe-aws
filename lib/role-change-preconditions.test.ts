import { describe, expect, it } from "vitest"

import { CONSUMED_HELD_STATUSES } from "@/lib/budget-consumption"
import { getOrderStatusesForFilter } from "@/lib/order-status"
import {
  ROLE_CHANGE_BLOCKING_STATUSES,
  evaluateRoleChangeReadiness,
  roleChangeRequiresSettledOrders,
  toRoleChangeBlockers,
  totalBlockingOrders,
} from "@/lib/role-change-preconditions"

describe("what blocks a role change", () => {
  it("blocks on exactly the statuses whose money the ledger still holds", () => {
    expect([...ROLE_CHANGE_BLOCKING_STATUSES]).toEqual([...CONSUMED_HELD_STATUSES])
    expect([...ROLE_CHANGE_BLOCKING_STATUSES].sort()).toEqual(["APPROVED", "PENDING"])
  })

  it("does not block on a settled order, in any of its settled forms", () => {
    const settled = [
      ...getOrderStatusesForFilter("fulfilled"),
      ...getOrderStatusesForFilter("rejected"),
      ...getOrderStatusesForFilter("refunded"),
    ]
    // A partially fulfilled order has moved its money and released its hold, so
    // it is finished as far as this rule is concerned.
    expect(settled).toContain("PARTIALLY_FULFILLED")
    for (const status of settled) {
      expect(ROLE_CHANGE_BLOCKING_STATUSES).not.toContain(status)
    }
  })

  it("stays derived from the order-status module rather than restating it", () => {
    // If a new pending-like status is added there it must reach this rule for
    // free. Naming the statuses here would let the two drift silently.
    expect([...ROLE_CHANGE_BLOCKING_STATUSES]).toEqual([
      ...getOrderStatusesForFilter("pending"),
      ...getOrderStatusesForFilter("approved"),
    ])
  })
})

describe("evaluateRoleChangeReadiness", () => {
  it("allows the change when nothing is in flight", () => {
    const verdict = evaluateRoleChangeReadiness({ pendingOrderCount: 0, approvedOrderCount: 0 })
    expect(verdict).toEqual({ ready: true })
  })

  it("blocks on a single pending order and says so", () => {
    const verdict = evaluateRoleChangeReadiness({ pendingOrderCount: 1, approvedOrderCount: 0 })
    expect(verdict.ready).toBe(false)
    if (verdict.ready) throw new Error("expected a block")
    expect(verdict.reason).toContain("1 order(s) still in progress")
    expect(verdict.reason).toContain("1 awaiting approval")
    expect(verdict.blockers).toEqual({ pendingOrderCount: 1, approvedOrderCount: 0 })
  })

  it("blocks on an approved-but-unfulfilled order — approval is not the end of the lifecycle", () => {
    const verdict = evaluateRoleChangeReadiness({ pendingOrderCount: 0, approvedOrderCount: 2 })
    expect(verdict.ready).toBe(false)
    if (verdict.ready) throw new Error("expected a block")
    expect(verdict.reason).toContain("2 approved but not yet fulfilled")
    expect(verdict.reason).not.toContain("awaiting approval")
  })

  it("names both counts when both are present", () => {
    const verdict = evaluateRoleChangeReadiness({ pendingOrderCount: 3, approvedOrderCount: 4 })
    if (verdict.ready) throw new Error("expected a block")
    expect(verdict.reason).toContain("7 order(s)")
    expect(verdict.reason).toContain("3 awaiting approval and 4 approved but not yet fulfilled")
  })
})

describe("toRoleChangeBlockers", () => {
  it("reads counts that arrive as strings from the driver", () => {
    expect(toRoleChangeBlockers({ pendingOrderCount: "2", approvedOrderCount: "5" }))
      .toEqual({ pendingOrderCount: 2, approvedOrderCount: 5 })
  })

  it("treats a missing, null or unparseable count as zero rather than NaN", () => {
    expect(toRoleChangeBlockers({})).toEqual({ pendingOrderCount: 0, approvedOrderCount: 0 })
    expect(toRoleChangeBlockers({ pendingOrderCount: null, approvedOrderCount: "oops" }))
      .toEqual({ pendingOrderCount: 0, approvedOrderCount: 0 })
  })

  it("never reports a negative count as blocking work", () => {
    expect(toRoleChangeBlockers({ pendingOrderCount: -3, approvedOrderCount: 0 }))
      .toEqual({ pendingOrderCount: 0, approvedOrderCount: 0 })
    expect(totalBlockingOrders(toRoleChangeBlockers({ pendingOrderCount: -3 }))).toBe(0)
  })
})

describe("roleChangeRequiresSettledOrders", () => {
  it("requires settled orders when the role actually changes", () => {
    expect(roleChangeRequiresSettledOrders("ORDER_PORTAL", "BRANCH_ADMIN")).toBe(true)
    expect(roleChangeRequiresSettledOrders("BRANCH_ADMIN", "ORDER_PORTAL")).toBe(true)
  })

  it("does not obstruct an unrelated access edit that leaves the role alone", () => {
    // Toggling MFA or moving a branch is not a move between portals, and making
    // it wait on an unrelated pending order would obstruct with no safety behind it.
    expect(roleChangeRequiresSettledOrders("ORDER_PORTAL", "ORDER_PORTAL")).toBe(false)
    expect(roleChangeRequiresSettledOrders("BRANCH_ADMIN", "BRANCH_ADMIN")).toBe(false)
  })
})
