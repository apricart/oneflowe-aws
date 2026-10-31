import { describe, expect, it } from "vitest"

import {
  availableQuantity,
  planOpeningBalances,
  planOrderIssue,
  planStockAdjustment,
  planStockShortfalls,
  quantitiesByProduct,
  stockKey,
  stockShortageMessage,
  stockShortfallMessage,
  transferStockShortfallMessage,
} from "@/lib/warehouse-stock"

const line = (globalProductId: number, quantity: number, productName = `P${globalProductId}`) => ({ globalProductId, quantity, productName })

describe("availability is on hand less what open orders reserve", () => {
  it("sums a product that appears on two lines", () => {
    expect(quantitiesByProduct([line(1, 2), line(1, 3.5), line(2, 1)]).get(1)).toEqual({ quantity: 5.5, productName: "P1" })
  })

  it("subtracts without float drift", () => {
    expect(availableQuantity(0.3, 0.1)).toBe(0.2)
  })

  it("refuses the second customer for the last ten units", () => {
    // 10 on hand; the first customer's 10 are reserved; the second asks for 10.
    const shortfalls = planStockShortfalls([line(1, 10, "Tissue")], new Map([[1, 10]]), new Map([[1, 10]]))
    expect(shortfalls).toEqual([{ globalProductId: 1, productName: "Tissue", requested: 10, available: 0 }])
  })

  it("lets the first customer take exactly what is there", () => {
    expect(planStockShortfalls([line(1, 10)], new Map([[1, 10]]), new Map())).toEqual([])
  })

  it("treats a product with no stock row as none on hand", () => {
    expect(planStockShortfalls([line(7, 1)], new Map(), new Map())).toEqual([
      { globalProductId: 7, productName: "P7", requested: 1, available: 0 },
    ])
  })

  it("never reports a negative availability when the warehouse is over-committed", () => {
    expect(planStockShortfalls([line(1, 1)], new Map([[1, 2]]), new Map([[1, 5]]))[0].available).toBe(0)
  })

  it("words the refusal exactly as the global check does", () => {
    expect(stockShortfallMessage({ globalProductId: 1, productName: "Tissue", requested: 10, available: 4 }))
      .toBe("Insufficient stock for Tissue. Available: 4, Requested: 10")
  })
})

describe("issuing an order at In Process", () => {
  it("takes each product's whole quantity off the shelf", () => {
    expect(planOrderIssue([line(1, 3), line(2, 1), line(1, 2)], new Map([[1, 10], [2, 1]]))).toEqual({
      ok: true,
      moves: [
        { globalProductId: 1, quantity: 5, balanceAfter: 5 },
        { globalProductId: 2, quantity: 1, balanceAfter: 0 },
      ],
    })
  })

  it("is refused for every product the shelf does not hold, and takes nothing", () => {
    expect(planOrderIssue([line(1, 3), line(2, 4)], new Map([[1, 2]]))).toEqual({
      ok: false,
      shortfalls: [
        { globalProductId: 1, productName: "P1", requested: 3, available: 2 },
        { globalProductId: 2, productName: "P2", requested: 4, available: 0 },
      ],
    })
  })

  it("names at most five products in the refusal", () => {
    const shortfalls = Array.from({ length: 7 }, (_, index) => ({ globalProductId: index, productName: `P${index}`, requested: 2, available: 1 }))
    expect(stockShortageMessage(shortfalls)).toContain("and 2 more")
    expect(transferStockShortfallMessage(shortfalls.slice(0, 1))).toContain("P0 (available 1, needed 2)")
  })
})

describe("Super Admin's adjustment", () => {
  const base = { onHand: 10, allowDecimalQuantity: false }

  it("sets a counted figure", () => {
    expect(planStockAdjustment({ ...base, mode: "set", quantity: 4 })).toEqual({ ok: true, delta: -6, onHandAfter: 4 })
  })

  it("adds and removes", () => {
    expect(planStockAdjustment({ ...base, mode: "add", quantity: 5 })).toEqual({ ok: true, delta: 5, onHandAfter: 15 })
    expect(planStockAdjustment({ ...base, mode: "remove", quantity: 10 })).toEqual({ ok: true, delta: -10, onHandAfter: 0 })
  })

  it("never goes below zero", () => {
    expect(planStockAdjustment({ ...base, mode: "remove", quantity: 11 })).toMatchObject({ ok: false })
  })

  it("refuses a fraction for a product counted in whole units, and allows it otherwise", () => {
    expect(planStockAdjustment({ ...base, mode: "set", quantity: 2.5 })).toMatchObject({ ok: false })
    expect(planStockAdjustment({ onHand: 1, allowDecimalQuantity: true, mode: "add", quantity: 0.25 })).toEqual({ ok: true, delta: 0.25, onHandAfter: 1.25 })
  })

  it("refuses a change that changes nothing, a zero add, a negative and more than three decimals", () => {
    expect(planStockAdjustment({ ...base, mode: "set", quantity: 10 })).toMatchObject({ ok: false })
    expect(planStockAdjustment({ ...base, mode: "add", quantity: 0 })).toMatchObject({ ok: false })
    expect(planStockAdjustment({ ...base, mode: "set", quantity: -1 })).toMatchObject({ ok: false })
    expect(planStockAdjustment({ onHand: 0, allowDecimalQuantity: true, mode: "set", quantity: 1.0005 })).toMatchObject({ ok: false })
  })

  it("allows setting a figure to zero", () => {
    expect(planStockAdjustment({ ...base, mode: "set", quantity: 0 })).toEqual({ ok: true, delta: -10, onHandAfter: 0 })
  })
})

describe("opening each warehouse from today's global figures", () => {
  const warehouses = [{ id: 1, code: "KARACHI-001", status: "ACTIVE" }, { id: 2, code: "LAHORE-001", status: "ACTIVE" }]

  it("opens each warehouse at today's figure plus what open orders hold, so available stays today's", () => {
    const plan = planOpeningBalances({
      warehouses,
      products: [{ id: 10, stockQuantity: 90 }, { id: 11, stockQuantity: 0 }, { id: 12, stockQuantity: 0 }],
      openQuantityByProduct: new Map([[10, 10], [11, 4]]),
      existing: new Set(),
    })
    expect(plan.refusals).toEqual([])
    expect(plan.rows).toEqual([
      { warehouseId: 1, globalProductId: 10, onHand: 100 },
      { warehouseId: 1, globalProductId: 11, onHand: 4 },
      { warehouseId: 2, globalProductId: 10, onHand: 100 },
      { warehouseId: 2, globalProductId: 11, onHand: 4 },
    ])
  })

  it("never touches a pair that already has a stock row", () => {
    const plan = planOpeningBalances({
      warehouses,
      products: [{ id: 10, stockQuantity: 5 }],
      openQuantityByProduct: new Map(),
      existing: new Set([stockKey(1, 10)]),
    })
    expect(plan.rows).toEqual([{ warehouseId: 2, globalProductId: 10, onHand: 5 }])
    expect(plan.skippedExisting).toBe(1)
  })

  it("refuses an inactive warehouse", () => {
    const plan = planOpeningBalances({
      warehouses: [{ id: 3, code: "OLD", status: "INACTIVE" }],
      products: [],
      openQuantityByProduct: new Map(),
      existing: new Set(),
    })
    expect(plan.refusals).toEqual(["Warehouse OLD is not active"])
  })
})
