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
  planRefundLedgerMove,
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

describe("planRefundLedgerMove", () => {
  /** What the branch has left after the move — the figure that must rise by exactly the refund. */
  function remainingAfter(row: { allocated: number; credited: number; spent: number; held: number }, move: ReturnType<typeof planRefundLedgerMove>) {
    return row.allocated + (row.credited + move.creditCents) - (row.spent - move.spentDebitCents) - row.held
  }

  it("withdraws a fulfilled order's refund from spent and credits nothing", () => {
    expect(planRefundLedgerMove({ orderStatus: "FULFILLED", refundCents: 125_000, rowSpentCents: 560_000 }))
      .toEqual({ spentDebitCents: 125_000, creditCents: 0 })
  })

  it("treats every fulfilled-family status as spent", () => {
    for (const status of CONSUMED_SPENT_STATUSES) {
      expect(planRefundLedgerMove({ orderStatus: status, refundCents: 1_000, rowSpentCents: 5_000 }), status)
        .toEqual({ spentDebitCents: 1_000, creditCents: 0 })
    }
  })

  it("never takes spent below zero: what the row cannot cover is credited", () => {
    expect(planRefundLedgerMove({ orderStatus: "FULFILLED", refundCents: 10_000, rowSpentCents: 4_000 }))
      .toEqual({ spentDebitCents: 4_000, creditCents: 6_000 })
    expect(planRefundLedgerMove({ orderStatus: "FULFILLED", refundCents: 10_000, rowSpentCents: 0 }))
      .toEqual({ spentDebitCents: 0, creditCents: 10_000 })
  })

  it("credits an unfulfilled order's refund and leaves its hold whole", () => {
    for (const status of CONSUMED_HELD_STATUSES) {
      expect(planRefundLedgerMove({ orderStatus: status, refundCents: 2_500, rowSpentCents: 99_000 }), status)
        .toEqual({ spentDebitCents: 0, creditCents: 2_500 })
    }
  })

  it("normalises the status as the consumption rules do", () => {
    expect(planRefundLedgerMove({ orderStatus: " fulfilled ", refundCents: 700, rowSpentCents: 700 }))
      .toEqual({ spentDebitCents: 700, creditCents: 0 })
  })

  it("credits when the status is missing or unknown rather than guessing at spent", () => {
    expect(planRefundLedgerMove({ orderStatus: null, refundCents: 300, rowSpentCents: 900 }))
      .toEqual({ spentDebitCents: 0, creditCents: 300 })
  })

  it("moves nothing for a zero or negative refund", () => {
    expect(planRefundLedgerMove({ orderStatus: "FULFILLED", refundCents: 0, rowSpentCents: 900 }))
      .toEqual({ spentDebitCents: 0, creditCents: 0 })
    expect(planRefundLedgerMove({ orderStatus: "FULFILLED", refundCents: -50, rowSpentCents: 900 }))
      .toEqual({ spentDebitCents: 0, creditCents: 0 })
  })

  it("always raises the branch's remaining by exactly the refund", () => {
    const row = { allocated: 5_000_000, credited: 20_000, spent: 560_000, held: 125_000 }
    for (const [status, refund, spent] of [
      ["FULFILLED", 125_000, 560_000],
      ["FULFILLED", 900_000, 560_000],
      ["APPROVED", 40_000, 560_000],
      ["PENDING", 1, 0],
    ] as const) {
      const before = row.allocated + row.credited - spent - row.held
      const move = planRefundLedgerMove({ orderStatus: status, refundCents: refund, rowSpentCents: spent })
      expect(remainingAfter({ ...row, spent }, move) - before, `${status} ${refund}`).toBe(refund)
    }
  })

  it("leaves the ledger agreeing with the order-side netting for a fulfilled order", () => {
    // One fulfilled order of 4,350 on the row; 1,250 of it refunded.
    const move = planRefundLedgerMove({ orderStatus: "FULFILLED", refundCents: 125_000, rowSpentCents: 435_000 })
    expect(435_000 - move.spentDebitCents).toBe(
      orderSpentCents({ status: "FULFILLED", totalCents: 435_000, refundAmountCents: 125_000 }),
    )
    expect(move.creditCents).toBe(0)
  })
})
