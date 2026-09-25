import { describe, expect, it } from "vitest"

import { BUDGET_BURN_THRESHOLDS } from "./budget-burn-risk"
import {
  buildItemPattern,
  itemPatternTotals,
  type ProductWindowRow,
} from "./budget-burn-item-comparison"

const MONTHS = ["2026-06", "2026-07", "2026-08"]
const T = BUDGET_BURN_THRESHOLDS

function product(overrides: Partial<ProductWindowRow> = {}): ProductWindowRow {
  return {
    productId: 1,
    productName: "Paper",
    unit: "Ream",
    quantity: 10,
    valueCents: 100_000,
    orderCount: 1,
    ...overrides,
  }
}

const consumed = (row: { months: Array<{ spendCents: number }> }) => row.months.map((month) => month.spendCents)
const quantities = (row: { months: Array<{ quantity: number }> }) => row.months.map((month) => month.quantity)

describe("the item-wise pattern", () => {
  it("lines one product up across every month, oldest first", () => {
    const [row] = buildItemPattern(MONTHS, [
      [product({ quantity: 10, valueCents: 5_000, orderCount: 1 })],
      [product({ quantity: 5, valueCents: 602_000, orderCount: 2 })],
      [product({ quantity: 102, valueCents: 2_250_000, orderCount: 3 })],
    ])
    expect(row.productId).toBe(1)
    expect(row.productName).toBe("Paper")
    expect(row.unit).toBe("Ream")
    expect(row.months.map((month) => month.month)).toEqual(MONTHS)
    expect(consumed(row)).toEqual([5_000, 602_000, 2_250_000])
    expect(quantities(row)).toEqual([10, 5, 102])
    expect(row.months.map((month) => month.orderCount)).toEqual([1, 2, 3])
  })

  it("keeps a product bought in only one month, with zeroes elsewhere", () => {
    const rows = buildItemPattern(MONTHS, [
      [product({ productId: 2, productName: "Stopped", quantity: 4, valueCents: 900_000 })],
      [],
      [product({ productId: 1, productName: "Started", quantity: 6, valueCents: 800_000 })],
    ])
    const byName = new Map(rows.map((row) => [row.productName, row]))
    expect(consumed(byName.get("Started")!)).toEqual([0, 0, 800_000])
    expect(consumed(byName.get("Stopped")!)).toEqual([900_000, 0, 0])
    // A purchase that never had a previous month has no baseline, not "no change".
    expect(byName.get("Started")!.momPct).toBeNull()
    // One that stopped fell to nothing and is never highlighted for it.
    expect(byName.get("Stopped")!.momPct).toBeNull()
    expect(byName.get("Stopped")!.momFlagged).toBe(false)
  })

  it("never combines units of the same product", () => {
    const rows = buildItemPattern(MONTHS, [
      [product({ unit: "Ream", quantity: 10 }), product({ unit: "Box", quantity: 2 })],
      [],
      [product({ unit: "Ream", quantity: 8 }), product({ unit: "Box", quantity: 5 })],
    ])
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.unit).sort()).toEqual(["Box", "Ream"])
    for (const row of rows) expect(row.months).toHaveLength(3)
  })

  it("compares the newest month with the one before it on money, by the shared rule", () => {
    const [row] = buildItemPattern(MONTHS, [
      // The oldest month is deliberately enormous and must not enter the figure.
      [product({ valueCents: 90_000_000 })],
      [product({ valueCents: 1_000_000 })],
      [product({ valueCents: 1_150_000 })],
    ])
    expect(row.momPct).toBeCloseTo(T.momSpikePct)
    expect(row.momFlagged).toBe(true)
  })

  it("does not highlight a rise from a base too small to read", () => {
    const [row] = buildItemPattern(MONTHS, [
      [],
      [product({ valueCents: T.momMinBaselineCents - 1 })],
      [product({ valueCents: 90_000_000 })],
    ])
    expect(row.momPct).toBeGreaterThan(1000)
    expect(row.momFlagged).toBe(false)
  })

  it("puts highlighted products first, then the largest of the newest month", () => {
    const rows = buildItemPattern(MONTHS, [
      [],
      [
        product({ productId: 1, productName: "Spiking", valueCents: 1_000_000 }),
        product({ productId: 2, productName: "Heavy", valueCents: 50_000_000 }),
      ],
      [
        product({ productId: 1, productName: "Spiking", valueCents: 2_000_000 }),
        product({ productId: 2, productName: "Heavy", valueCents: 50_000_000 }),
      ],
    ])
    expect(rows.map((row) => row.productName)).toEqual(["Spiking", "Heavy"])
    expect(rows[0].momFlagged).toBe(true)
    expect(rows[1].momFlagged).toBe(false)
  })

  it("floors a negative or unreadable figure at zero", () => {
    const [row] = buildItemPattern(MONTHS, [
      [product({ quantity: -4, valueCents: -100, orderCount: -1 })],
      [],
      [product({ quantity: Number.NaN, valueCents: Number.NaN, orderCount: Number.NaN })],
    ])
    expect(consumed(row)).toEqual([0, 0, 0])
    expect(quantities(row)).toEqual([0, 0, 0])
    expect(row.months.map((month) => month.orderCount)).toEqual([0, 0, 0])
  })

  it("prefers the newest name for a product renamed mid-window", () => {
    const [row] = buildItemPattern(MONTHS, [
      [product({ productName: "Old Name" })],
      [],
      [product({ productName: "New Name" })],
    ])
    expect(row.productName).toBe("New Name")
  })

  it("returns nothing when nothing was bought in any month", () => {
    expect(buildItemPattern(MONTHS, [[], [], []])).toEqual([])
    expect(itemPatternTotals(MONTHS, [])).toEqual([
      { month: "2026-06", quantity: 0, spendCents: 0, orderCount: 0 },
      { month: "2026-07", quantity: 0, spendCents: 0, orderCount: 0 },
      { month: "2026-08", quantity: 0, spendCents: 0, orderCount: 0 },
    ])
  })
})

describe("the per-month totals", () => {
  it("adds every product up per month, so the panel reconciles with the row above it", () => {
    const rows = buildItemPattern(MONTHS, [
      [product({ productId: 1, valueCents: 5_000, quantity: 10 }), product({ productId: 2, productName: "Toner", unit: "Piece", valueCents: 6_000, quantity: 2 })],
      [product({ productId: 1, valueCents: 602_000, quantity: 5 })],
      [product({ productId: 1, valueCents: 2_250_000, quantity: 102 })],
    ])
    const totals = itemPatternTotals(MONTHS, rows)
    expect(totals.map((total) => total.spendCents)).toEqual([11_000, 602_000, 2_250_000])
    expect(totals.map((total) => total.quantity)).toEqual([12, 5, 102])
    expect(totals.map((total) => total.month)).toEqual(MONTHS)
  })
})
