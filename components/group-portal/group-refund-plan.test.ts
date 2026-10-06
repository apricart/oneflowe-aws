import { describe, expect, it } from "vitest"

import {
  applyProductToAllBranches,
  buildProductGroups,
  clampToRemaining,
  clearOrder,
  clearProductEverywhere,
  orderSubtotalCents,
  quantityFor,
  setLineQuantity,
  stepForLine,
  summarizeSelection,
  toRequestPayload,
  type RefundSelection,
} from "./group-refund-plan"

/**
 * The group refund screen's selection model. Two branch orders share Paper;
 * only North also has Toner.
 *
 *   North (order 1): Paper 4 left @ 5.00 (line 11), Toner 2 left @ 30.00 (line 12)
 *   South (order 2): Paper 1.5 left @ 5.00 (line 21, decimal step 0.5)
 */
const line = (overrides: Record<string, unknown>) => ({
  productCode: null,
  unit: "Ream",
  quantityOrdered: 10,
  allowDecimalQuantity: false,
  quantityStep: null,
  ...overrides,
}) as any

const NORTH = {
  orderId: 1, tid: "T-1", branchId: 101, branchName: "North", status: "FULFILLED", fulfillmentStatus: "DELIVERED",
  totalCents: 10_000, remainingRefundableCents: 10_000, createdAt: null,
  lines: [
    line({ orderItemId: 11, productName: "Paper", globalProductId: 7, priceCents: 500, quantityRemaining: 4 }),
    line({ orderItemId: 12, productName: "Toner", globalProductId: 8, priceCents: 3_000, quantityRemaining: 2 }),
  ],
} as any
const SOUTH = {
  orderId: 2, tid: "T-2", branchId: 102, branchName: "South", status: "FULFILLED", fulfillmentStatus: "DELIVERED",
  totalCents: 5_000, remainingRefundableCents: 5_000, createdAt: null,
  lines: [line({ orderItemId: 21, productName: "Paper", globalProductId: 7, priceCents: 500, quantityRemaining: 1.5, allowDecimalQuantity: true, quantityStep: 0.5 })],
} as any

describe("selection editing", () => {
  it("sets and reads a line, dropping a line set to zero and an order left empty", () => {
    let selection: RefundSelection = {}
    selection = setLineQuantity(selection, 1, 11, 2)
    selection = setLineQuantity(selection, 1, 12, 1)
    expect(quantityFor(selection, 1, 11)).toBe(2)
    expect(quantityFor(selection, 9, 99)).toBe(0)

    selection = setLineQuantity(selection, 1, 11, 0)
    expect(selection).toEqual({ 1: { 12: 1 } })
    selection = setLineQuantity(selection, 1, 12, -3)
    expect(selection).toEqual({})
  })

  it("never mutates the selection it was given", () => {
    const original: RefundSelection = { 1: { 11: 1 } }
    setLineQuantity(original, 1, 11, 3)
    clearOrder(original, 1)
    expect(original).toEqual({ 1: { 11: 1 } })
  })

  it("rounds quantities to the stored scale", () => {
    expect(quantityFor(setLineQuantity({}, 2, 21, 0.1 + 0.2), 2, 21)).toBe(0.3)
  })
})

describe("product groups", () => {
  it("rolls shared products up across branches, sorted by name, with the smallest and largest remaining", () => {
    const groups = buildProductGroups([NORTH, SOUTH])
    expect(groups.map((group) => group.productName)).toEqual(["Paper", "Toner"])
    const paper = groups[0]
    expect(paper.occurrences.map((occurrence) => occurrence.branchName)).toEqual(["North", "South"])
    expect(paper.smallestRemaining).toBe(1.5)
    expect(paper.largestRemaining).toBe(4)
  })

  it("is empty for no orders", () => {
    expect(buildProductGroups([])).toEqual([])
  })

  it("applies one quantity everywhere, capping a branch that has less and naming it", () => {
    const [paper] = buildProductGroups([NORTH, SOUTH])
    const result = applyProductToAllBranches({}, paper, 2)
    expect(result.selection).toEqual({ 1: { 11: 2 }, 2: { 21: 1.5 } })
    expect(result.cappedBranchNames).toEqual(["South"])

    const exact = applyProductToAllBranches({}, paper, 1)
    expect(exact.cappedBranchNames).toEqual([])
  })

  it("clears a product everywhere while leaving other products selected", () => {
    const [paper, toner] = buildProductGroups([NORTH, SOUTH])
    let selection = applyProductToAllBranches({}, paper, 1).selection
    selection = applyProductToAllBranches(selection, toner, 1).selection
    expect(clearProductEverywhere(selection, paper)).toEqual({ 1: { 12: 1 } })
  })
})

describe("money and payload", () => {
  const selection: RefundSelection = { 1: { 11: 3, 12: 1 }, 2: { 21: 0.5 } }

  it("prices each order and sums the selection", () => {
    expect(orderSubtotalCents(selection, NORTH)).toBe(4_500)
    expect(orderSubtotalCents(selection, SOUTH)).toBe(250)
    expect(summarizeSelection(selection, [NORTH, SOUTH])).toEqual({
      branchCount: 2,
      lineCount: 3,
      totalQuantity: 4.5,
      totalCents: 4_750,
    })
    expect(summarizeSelection({}, [NORTH, SOUTH])).toEqual({ branchCount: 0, lineCount: 0, totalQuantity: 0, totalCents: 0 })
  })

  it("builds the API payload without zero lines or empty orders", () => {
    expect(toRequestPayload({ ...selection, 3: { 31: 0 } })).toEqual([
      { orderId: 1, items: [{ id: 11, quantity: 3 }, { id: 12, quantity: 1 }] },
      { orderId: 2, items: [{ id: 21, quantity: 0.5 }] },
    ])
  })
})

describe("quantity fields", () => {
  it("clamps a typed quantity into what is left", () => {
    expect(clampToRemaining(NORTH.lines[0], 9)).toBe(4)
    expect(clampToRemaining(NORTH.lines[0], 2)).toBe(2)
    expect(clampToRemaining(NORTH.lines[0], -1)).toBe(0)
    expect(clampToRemaining(NORTH.lines[0], Number.NaN)).toBe(0)
  })

  it("steps whole units by one and decimal units by their step or 0.1", () => {
    expect(stepForLine(NORTH.lines[0])).toBe(1)
    expect(stepForLine(SOUTH.lines[0])).toBe(0.5)
    expect(stepForLine({ ...SOUTH.lines[0], quantityStep: null })).toBe(0.1)
  })
})
