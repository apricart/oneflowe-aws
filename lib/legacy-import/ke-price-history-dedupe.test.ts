import { describe, expect, it } from "vitest"

import {
  planPriceHistoryDedupe,
  visiblePriceHistoryRows,
  type PriceHistoryRow,
} from "./ke-price-history-dedupe"

const DIST = 1
const ENAB = 2
const TRAN = 3

let nextId = 1
function row(seq: number, groupId: number | null, price: number, extra: Partial<PriceHistoryRow> = {}): PriceHistoryRow {
  return {
    id: nextId++,
    globalProductId: 7,
    groupId,
    priceCents: price,
    previousPriceCents: null,
    source: "ORDER_BACKFILL",
    seq,
    ...extra,
  }
}

function after(rows: PriceHistoryRow[]) {
  const plan = planPriceHistoryDedupe(rows)
  const removed = new Set(plan.removals.map((r) => r.removedId))
  return { plan, shown: visiblePriceHistoryRows(rows.filter((r) => !removed.has(r.id))) }
}

/** Today's list with each run of one price collapsed to a single entry. */
function collapsed(rows: PriceHistoryRow[]): number[] {
  return visiblePriceHistoryRows(rows).map((r) => r.priceCents)
    .filter((price, i, all) => i === 0 || all[i - 1] !== price)
}

function expectNoNeighbouringDuplicates(prices: number[]) {
  for (let i = 1; i < prices.length; i += 1) expect(prices[i]).not.toBe(prices[i - 1])
}

describe("visiblePriceHistoryRows", () => {
  it("lists a derived row only when its own group's previous price differs", () => {
    const rows = [row(1, DIST, 155), row(2, DIST, 155), row(3, DIST, 195), row(4, ENAB, 195)]
    expect(visiblePriceHistoryRows(rows).map((r) => r.seq)).toEqual([3])
  })

  it("ignores zero prices, as the screen filters them before ranking", () => {
    const rows = [row(1, DIST, 155), row(2, DIST, 0), row(3, DIST, 195)]
    expect(visiblePriceHistoryRows(rows).map((r) => r.priceCents)).toEqual([195])
  })

  it("judges a catalogue edit by its recorded previous price", () => {
    const rows = [row(1, null, 200, { source: "CATALOG_CHANGE", previousPriceCents: 180 })]
    expect(visiblePriceHistoryRows(rows)).toHaveLength(1)
  })
})

describe("planPriceHistoryDedupe", () => {
  it("collapses two neighbouring equal prices from different groups to one", () => {
    const rows = [row(1, DIST, 155), row(2, ENAB, 155), row(3, DIST, 195), row(4, ENAB, 195)]
    const { plan, shown } = after(rows)
    expect(shown.map((r) => r.priceCents)).toEqual([195])
    expect(plan.removals).toHaveLength(1)
  })

  it("leaves a list with no neighbouring duplicates untouched", () => {
    const rows = [row(1, DIST, 155), row(2, DIST, 195), row(3, DIST, 155)]
    expect(planPriceHistoryDedupe(rows).removals).toEqual([])
  })

  it("keeps every genuine change while removing duplicates across interleaved groups", () => {
    const rows = [
      row(1, DIST, 155), row(2, ENAB, 155), row(3, TRAN, 155),
      row(4, DIST, 195), row(5, ENAB, 195),
      row(6, DIST, 155), row(7, TRAN, 195),
      row(8, DIST, 195), row(9, ENAB, 155),
    ]
    const { shown } = after(rows)
    const prices = shown.map((r) => r.priceCents)
    expectNoNeighbouringDuplicates(prices)
    expect(prices).toEqual(collapsed(rows))
  })

  it("hides a duplicate by removing the hidden row before it rather than losing other changes", () => {
    // Shape of production product 291: three groups open at 320 (hidden), then
    // each moves to 390 on its own — three 390s in a row on the screen.
    const rows = [
      row(1, DIST, 320), row(2, ENAB, 320), row(3, TRAN, 320),
      row(4, DIST, 390), row(5, ENAB, 390), row(6, TRAN, 390),
      row(7, DIST, 320), row(8, DIST, 390), row(9, ENAB, 320), row(10, ENAB, 390),
    ]
    const { plan, shown } = after(rows)
    expect(shown.map((r) => r.priceCents)).toEqual([390, 320, 390, 320, 390])
    expect(plan.removals).toHaveLength(2)
  })

  it("only ever lists rows the screen lists today", () => {
    const rows = [
      row(1, DIST, 155), row(2, ENAB, 155), row(3, DIST, 195), row(4, ENAB, 195),
      row(5, DIST, 195), row(6, DIST, 155), row(7, ENAB, 155),
    ]
    const today = new Set(visiblePriceHistoryRows(rows).map((r) => r.id))
    for (const shownRow of after(rows).shown) expect(today.has(shownRow.id)).toBe(true)
  })

  it("never removes a live catalogue edit, and reports a product where two collide", () => {
    const rows = [
      row(1, null, 195, { source: "CATALOG_CHANGE", previousPriceCents: 155 }),
      row(2, null, 195, { source: "CATALOG_CHANGE", previousPriceCents: 155 }),
    ]
    const plan = planPriceHistoryDedupe(rows)
    expect(plan.removals).toEqual([])
    expect(plan.unresolvedProductIds).toEqual([7])
  })

  it("removes only derived rows when a catalogue edit is one of the neighbours", () => {
    const rows = [
      row(1, DIST, 155), row(2, DIST, 195),
      row(3, null, 195, { source: "CATALOG_CHANGE", previousPriceCents: 155 }),
    ]
    const { plan, shown } = after(rows)
    expect(shown.map((r) => r.priceCents)).toEqual([195])
    for (const removal of plan.removals) {
      expect(rows.find((r) => r.id === removal.removedId)?.source).not.toBe("CATALOG_CHANGE")
    }
  })

  it("plans each product independently", () => {
    const a = [row(1, DIST, 100), row(2, DIST, 120), row(3, ENAB, 100), row(4, ENAB, 120)]
    const b = a.map((r) => ({ ...r, id: r.id + 1000, globalProductId: 8 }))
    const plan = planPriceHistoryDedupe([...a, ...b])
    expect(plan.removals.map((r) => r.globalProductId)).toEqual([7, 8])
  })

  it("never removes zero-price rows", () => {
    const rows = [row(1, DIST, 0), row(2, ENAB, 0)]
    expect(planPriceHistoryDedupe(rows).removals).toEqual([])
  })
})
