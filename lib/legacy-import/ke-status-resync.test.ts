import { describe, expect, it } from "vitest"

import {
  lifecycleRank,
  planStatusResync,
  summarizeStatusResync,
  type CurrentOrder,
  type LegacyStatusRow,
} from "./ke-status-resync"

const LIVE = 2
const CANCELLED = 5
const TEST_ORDER = 4

function order(overrides: Partial<CurrentOrder> = {}): CurrentOrder {
  return {
    orderId: 100,
    legacyOrderId: 1000,
    status: "APPROVED",
    fulfillmentStatus: "NOT_STARTED",
    refundAmountCents: 0,
    ...overrides,
  }
}

function legacy(overrides: Partial<LegacyStatusRow> = {}): LegacyStatusRow {
  return { legacyOrderId: 1000, legacyStatusId: LIVE, deliveryStatus: 507, ...overrides }
}

describe("lifecycleRank", () => {
  it("orders the lifecycle forwards", () => {
    const placed = lifecycleRank("APPROVED", "NOT_STARTED")!
    const processing = lifecycleRank("APPROVED", "IN_PROCESS")!
    const outForDelivery = lifecycleRank("APPROVED", "OUT_FOR_DELIVERY")!
    const delivered = lifecycleRank("FULFILLED", "DELIVERED")!
    expect(placed).toBeLessThan(processing)
    expect(processing).toBeLessThan(outForDelivery)
    expect(outForDelivery).toBeLessThan(delivered)
  })

  it("treats a missing fulfilment status as the start of the lifecycle", () => {
    expect(lifecycleRank("APPROVED", null)).toBe(lifecycleRank("APPROVED", "NOT_STARTED"))
  })

  it("refuses to rank a status it does not know", () => {
    expect(lifecycleRank("REFUNDED", "DELIVERED")).toBeNull()
    expect(lifecycleRank("APPROVED", "TELEPORTED")).toBeNull()
  })
})

describe("planStatusResync", () => {
  it("advances an order legacy has since delivered", () => {
    const plan = planStatusResync([order()], [legacy({ deliveryStatus: 507 })])
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0]).toMatchObject({
      orderId: 100,
      fromStatus: "APPROVED",
      toStatus: "FULFILLED",
      toFulfillmentStatus: "DELIVERED",
    })
    expect(plan.holds).toHaveLength(0)
  })

  it("counts an order that already agrees, and plans nothing for it", () => {
    const plan = planStatusResync(
      [order({ status: "FULFILLED", fulfillmentStatus: "DELIVERED" })],
      [legacy({ deliveryStatus: 507 })],
    )
    expect(plan.changes).toHaveLength(0)
    expect(plan.unchanged).toBe(1)
  })

  // Rule 1. Legacy order 619 in production: refunded here, merely delivered there.
  it("never restates an order that is REFUNDED in OneFlowe", () => {
    const plan = planStatusResync(
      [order({ status: "REFUNDED", fulfillmentStatus: "DELIVERED" })],
      [legacy({ deliveryStatus: 507 })],
    )
    expect(plan.changes).toHaveLength(0)
    expect(plan.holds[0].reason).toBe("REFUNDED_LOCALLY")
  })

  it("never restates an order carrying a refund amount, whatever its status", () => {
    const plan = planStatusResync(
      [order({ status: "APPROVED", fulfillmentStatus: "NOT_STARTED", refundAmountCents: 5_000 })],
      [legacy({ deliveryStatus: 507 })],
    )
    expect(plan.changes).toHaveLength(0)
    expect(plan.holds[0].reason).toBe("REFUNDED_LOCALLY")
  })

  // Rule 2. Legacy order 1155 in production: fulfilled here, out for delivery there.
  it("holds a transition that would move the order backwards", () => {
    const plan = planStatusResync(
      [order({ status: "FULFILLED", fulfillmentStatus: "DELIVERED" })],
      [legacy({ deliveryStatus: 506 })],
    )
    expect(plan.changes).toHaveLength(0)
    expect(plan.holds[0]).toMatchObject({
      reason: "BACKWARD_TRANSITION",
      legacyMeans: "APPROVED/OUT_FOR_DELIVERY",
    })
  })

  // Rule 3.
  it.each([
    ["cancelled", CANCELLED],
    ["a test order", TEST_ORDER],
  ])("holds an order whose legacy row is now %s", (_label, legacyStatusId) => {
    const plan = planStatusResync([order()], [legacy({ legacyStatusId, deliveryStatus: 507 })])
    expect(plan.changes).toHaveLength(0)
    expect(plan.holds[0].reason).toBe("LEGACY_NOT_LIVE")
  })

  it("holds an order whose delivery status has no mapping", () => {
    const plan = planStatusResync([order()], [legacy({ deliveryStatus: 599 })])
    expect(plan.changes).toHaveLength(0)
    expect(plan.holds[0].reason).toBe("UNMAPPED_DELIVERY_STATUS")
  })

  it("reports an imported order legacy no longer returns, and plans nothing for it", () => {
    const plan = planStatusResync([order({ legacyOrderId: 41 })], [])
    expect(plan.missingFromLegacy).toEqual([41])
    expect(plan.changes).toHaveLength(0)
    expect(plan.holds).toHaveLength(0)
  })

  it("is deterministic regardless of input order", () => {
    const orders = [
      order({ orderId: 3, legacyOrderId: 30 }),
      order({ orderId: 1, legacyOrderId: 10 }),
      order({ orderId: 2, legacyOrderId: 20 }),
    ]
    const rows = [legacy({ legacyOrderId: 10 }), legacy({ legacyOrderId: 20 }), legacy({ legacyOrderId: 30 })]
    const forward = planStatusResync(orders, rows)
    const reversed = planStatusResync([...orders].reverse(), [...rows].reverse())
    expect(forward).toEqual(reversed)
    expect(forward.changes.map((c) => c.legacyOrderId)).toEqual([10, 20, 30])
  })

  it("advances in-process to delivered but not the reverse", () => {
    const forward = planStatusResync(
      [order({ status: "APPROVED", fulfillmentStatus: "IN_PROCESS" })],
      [legacy({ deliveryStatus: 507 })],
    )
    expect(forward.changes).toHaveLength(1)
    const backward = planStatusResync(
      [order({ status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY" })],
      [legacy({ deliveryStatus: 503 })],
    )
    expect(backward.holds[0].reason).toBe("BACKWARD_TRANSITION")
  })

  it("maps partial delivery to delivered, as the importer does", () => {
    const plan = planStatusResync([order()], [legacy({ deliveryStatus: 505 })])
    expect(plan.changes[0]).toMatchObject({ toStatus: "FULFILLED", toFulfillmentStatus: "DELIVERED" })
  })
})

describe("summarizeStatusResync", () => {
  it("accounts for every order exactly once", () => {
    const plan = planStatusResync(
      [
        order({ orderId: 1, legacyOrderId: 10 }),
        order({ orderId: 2, legacyOrderId: 20, status: "REFUNDED" }),
        order({ orderId: 3, legacyOrderId: 30, status: "FULFILLED", fulfillmentStatus: "DELIVERED" }),
        order({ orderId: 4, legacyOrderId: 40 }),
      ],
      [
        legacy({ legacyOrderId: 10, deliveryStatus: 507 }),
        legacy({ legacyOrderId: 20, deliveryStatus: 507 }),
        legacy({ legacyOrderId: 30, deliveryStatus: 507 }),
      ],
    )
    const counts = summarizeStatusResync(plan)
    expect(counts).toMatchObject({ toChange: 1, unchanged: 1, held: 1, missingFromLegacy: 1 })
    expect(counts.ordersConsidered).toBe(4)
    expect(counts.byHoldReason).toEqual({ REFUNDED_LOCALLY: 1 })
  })
})
