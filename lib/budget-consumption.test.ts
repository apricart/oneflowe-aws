import { describe, expect, it } from "vitest"

import {
  CONSUMED_HELD_STATUSES,
  CONSUMED_SPENT_STATUSES,
  budgetPeriodOf,
  classifyOrderConsumption,
  isSameBudgetPeriod,
  orderConsumptionCents,
  orderHeldCents,
  orderSpentCents,
  summarizeOrderConsumption,
} from "@/lib/budget-consumption"
import { getOrderStatusesForFilter } from "@/lib/order-status"

describe("consumption status sets", () => {
  it("takes spend from the app's own fulfilled-status list", () => {
    expect([...CONSUMED_SPENT_STATUSES].sort()).toEqual(
      [...getOrderStatusesForFilter("fulfilled")].sort(),
    )
  })

  it("takes commitment from pending plus approved", () => {
    expect([...CONSUMED_HELD_STATUSES].sort()).toEqual(["APPROVED", "PENDING"])
  })

  it("never puts a status in both buckets", () => {
    const overlap = CONSUMED_SPENT_STATUSES.filter((status) => CONSUMED_HELD_STATUSES.includes(status))
    expect(overlap).toEqual([])
  })
})

describe("classifyOrderConsumption", () => {
  it.each([
    ["FULFILLED", "spent"],
    ["PARTIAL", "spent"],
    ["PARTIALLY_FULFILLED", "spent"],
    ["PENDING", "held"],
    ["APPROVED", "held"],
    ["REJECTED", "none"],
    ["CANCELLED", "none"],
    ["REFUNDED", "none"],
  ])("puts %s in the %s bucket", (status, bucket) => {
    expect(classifyOrderConsumption({ status })).toBe(bucket)
  })

  it("normalises case and surrounding space", () => {
    expect(classifyOrderConsumption({ status: "  fulfilled " })).toBe("spent")
  })

  it("treats a missing or unknown status as consuming nothing", () => {
    expect(classifyOrderConsumption({})).toBe("none")
    expect(classifyOrderConsumption({ status: null })).toBe("none")
    expect(classifyOrderConsumption({ status: "SOMETHING_NEW" })).toBe("none")
  })
})

describe("orderConsumptionCents", () => {
  it("nets an approved refund off the order total", () => {
    expect(orderConsumptionCents({ totalCents: 10_000, refundAmountCents: 2_500 })).toBe(7_500)
  })

  it("treats a null refund as nothing refunded", () => {
    expect(orderConsumptionCents({ totalCents: 10_000, refundAmountCents: null })).toBe(10_000)
    expect(orderConsumptionCents({ totalCents: 10_000 })).toBe(10_000)
  })

  it("clamps at zero when a repaired row refunds more than the order", () => {
    expect(orderConsumptionCents({ totalCents: 10_000, refundAmountCents: 12_000 })).toBe(0)
  })

  it("is zero for a fully refunded order", () => {
    expect(orderConsumptionCents({ totalCents: 10_000, refundAmountCents: 10_000 })).toBe(0)
  })

  it("reads numeric strings, as the driver can return them", () => {
    expect(orderConsumptionCents({ totalCents: "10000", refundAmountCents: "2500" })).toBe(7_500)
  })

  it("treats an unparseable amount as zero rather than NaN", () => {
    expect(orderConsumptionCents({ totalCents: "abc", refundAmountCents: null })).toBe(0)
  })
})

describe("per-order bucket contributions", () => {
  it("counts a partially refunded fulfilled order as net spend only", () => {
    const order = { status: "FULFILLED", totalCents: 10_000, refundAmountCents: 4_000 }
    expect(orderSpentCents(order)).toBe(6_000)
    expect(orderHeldCents(order)).toBe(0)
  })

  it("counts a pending order as commitment only", () => {
    const order = { status: "PENDING", totalCents: 10_000 }
    expect(orderSpentCents(order)).toBe(0)
    expect(orderHeldCents(order)).toBe(10_000)
  })

  it("counts a rejected order as neither", () => {
    const order = { status: "REJECTED", totalCents: 10_000 }
    expect(orderSpentCents(order)).toBe(0)
    expect(orderHeldCents(order)).toBe(0)
  })
})

describe("budgetPeriodOf", () => {
  it("names the UTC month, which is the month the ledger row carries", () => {
    expect(budgetPeriodOf(new Date("2026-09-15T12:00:00.000Z"))).toBe("2026-09")
  })

  it("keeps an order at 23:00 UTC on the last of the month in that month", () => {
    expect(budgetPeriodOf(new Date("2026-09-30T23:59:59.999Z"))).toBe("2026-09")
    expect(budgetPeriodOf(new Date("2026-10-01T00:00:00.000Z"))).toBe("2026-10")
  })

  it("does not follow Karachi into the next month during the five-hour overlap", () => {
    // 02:00 on 1 October in Karachi is still 21:00 on 30 September in UTC, and
    // the hold for an order placed then went onto the September row.
    expect(budgetPeriodOf(new Date("2026-09-30T21:00:00.000Z"))).toBe("2026-09")
  })

  it("accepts an ISO string and a timestamp, as rows and drivers supply both", () => {
    expect(budgetPeriodOf("2026-03-04T05:06:07.000Z")).toBe("2026-03")
    expect(budgetPeriodOf(Date.parse("2026-03-04T05:06:07.000Z"))).toBe("2026-03")
  })

  it("falls back to now rather than throwing on a missing or unusable date", () => {
    const now = budgetPeriodOf(new Date())
    expect(budgetPeriodOf(null)).toBe(now)
    expect(budgetPeriodOf(undefined)).toBe(now)
    expect(budgetPeriodOf("not a date")).toBe(now)
  })
})

describe("isSameBudgetPeriod", () => {
  it("is true within one month and false across its edge", () => {
    expect(isSameBudgetPeriod("2026-09-01T00:00:00.000Z", "2026-09-30T23:59:59.999Z")).toBe(true)
    expect(isSameBudgetPeriod("2026-09-30T23:59:59.999Z", "2026-10-01T00:00:00.000Z")).toBe(false)
  })

  it("does not confuse the same month in different years", () => {
    expect(isSameBudgetPeriod("2025-12-31T23:00:00.000Z", "2026-12-31T23:00:00.000Z")).toBe(false)
    expect(isSameBudgetPeriod("2025-12-31T23:00:00.000Z", "2026-01-01T01:00:00.000Z")).toBe(false)
  })
})

describe("summarizeOrderConsumption", () => {
  it("is the oracle the database is checked against", () => {
    const summary = summarizeOrderConsumption([
      { status: "FULFILLED", totalCents: 10_000 },
      { status: "FULFILLED", totalCents: 10_000, refundAmountCents: 3_000 },
      { status: "PARTIALLY_FULFILLED", totalCents: 5_000 },
      { status: "PENDING", totalCents: 2_000 },
      { status: "APPROVED", totalCents: 1_500, refundAmountCents: 500 },
      { status: "REJECTED", totalCents: 9_999 },
      { status: "CANCELLED", totalCents: 9_999 },
      { status: "REFUNDED", totalCents: 9_999, refundAmountCents: 9_999 },
    ])

    expect(summary.spentCents).toBe(22_000)
    expect(summary.heldCents).toBe(3_000)
    expect(summary.consumedCents).toBe(25_000)
  })

  it("is zero for no orders", () => {
    expect(summarizeOrderConsumption([])).toEqual({ spentCents: 0, heldCents: 0, consumedCents: 0 })
  })
})
