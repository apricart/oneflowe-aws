import { describe, expect, it } from "vitest"

import {
  buildItemComparison,
  type ProductWindowRow,
} from "./budget-burn-item-comparison"

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

describe("item-wise budget-burn comparison", () => {
  it("merges a matching product and unit and reports quantity, spend and order counts", () => {
    const [row] = buildItemComparison(
      [product({ quantity: 15, valueCents: 180_000, orderCount: 3 })],
      [product({ quantity: 10, valueCents: 100_000, orderCount: 2 })],
    )
    expect(row).toEqual({
      productId: 1,
      productName: "Paper",
      unit: "Ream",
      currentQuantity: 15,
      priorQuantity: 10,
      deltaQuantity: 5,
      deltaPct: 50,
      currentSpendCents: 180_000,
      priorSpendCents: 100_000,
      currentOrderCount: 3,
      priorOrderCount: 2,
    })
  })

  it("keeps products bought in only one window and uses null for a missing baseline", () => {
    const rows = buildItemComparison(
      [product({ productId: 1, productName: "New", quantity: 6 })],
      [product({ productId: 2, productName: "Stopped", quantity: 4 })],
    )
    expect(rows.map((row) => ({
      name: row.productName,
      current: row.currentQuantity,
      prior: row.priorQuantity,
      delta: row.deltaQuantity,
      pct: row.deltaPct,
    }))).toEqual([
      { name: "New", current: 6, prior: 0, delta: 6, pct: null },
      { name: "Stopped", current: 0, prior: 4, delta: -4, pct: -100 },
    ])
  })

  it("never combines units of the same product", () => {
    const rows = buildItemComparison(
      [product({ unit: "Ream", quantity: 10 }), product({ unit: "Box", quantity: 2 })],
      [product({ unit: "Ream", quantity: 8 }), product({ unit: "Box", quantity: 5 })],
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => [row.unit, row.deltaQuantity])).toEqual([["Box", -3], ["Ream", 2]])
  })

  it("sorts by absolute quantity change, then current quantity", () => {
    const rows = buildItemComparison([
      product({ productId: 1, productName: "A", quantity: 12 }),
      product({ productId: 2, productName: "B", quantity: 15 }),
      product({ productId: 3, productName: "C", quantity: 2 }),
    ], [
      product({ productId: 1, productName: "A", quantity: 10 }),
      product({ productId: 2, productName: "B", quantity: 13 }),
      product({ productId: 3, productName: "C", quantity: 10 }),
    ])
    expect(rows.map((row) => row.productName)).toEqual(["C", "B", "A"])
  })
})
