import { describe, expect, it } from "vitest"

import { OTHER_SERIES_ID } from "@/lib/product-consumption-trend"

import { assignSeriesColors } from "./monthly-consumption-chart"

const PALETTE = ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"]
const series = (...productIds: number[]) => productIds.map((productId) => ({ productId }))

describe("assignSeriesColors", () => {
  it("never gives two lines on screen the same colour", () => {
    // 1 and 9 both seed at slot 1; the second must be probed onward rather than
    // drawn in the first one's colour.
    const colors = assignSeriesColors(series(1, 9, 17, 25), PALETTE)
    expect(new Set(Object.values(colors)).size).toBe(4)
  })

  it("keeps a product's colour when a filter changes which others are drawn", () => {
    // The rule this exists for: ranking the palette would repaint every
    // survivor the moment the top five changed, so "the blue one" would quietly
    // become a different product. Products that seed into different slots are
    // unaffected by who joins or leaves around them.
    const before = assignSeriesColors(series(1, 2, 3), PALETTE)
    const after = assignSeriesColors(series(2, 3, 4, 5), PALETTE)
    expect(after[2]).toBe(before[2])
    expect(after[3]).toBe(before[3])
  })

  it("moves a probed product only when its colliding partner leaves", () => {
    // The honest limit of the scheme: 11 and 3 seed into the same slot, so 11
    // sits one along. With 3 gone it takes its own seed back. Eight slots
    // cannot promise more than this, which is why the legend and tooltip name
    // every line rather than leaving colour to do it.
    const withCollision = assignSeriesColors(series(3, 11), PALETTE)
    const without = assignSeriesColors(series(11), PALETTE)
    expect(withCollision[11]).not.toBe(without[11])
    expect(without[11]).toBe(PALETTE[3])
  })

  it("does not follow rank — reordering the same set changes nothing", () => {
    expect(assignSeriesColors(series(2, 5, 6), PALETTE))
      .toEqual(assignSeriesColors(series(6, 2, 5), PALETTE))
  })

  it("leaves the Other remainder unassigned, so it can wear a neutral", () => {
    const colors = assignSeriesColors(series(4, OTHER_SERIES_ID), PALETTE)
    expect(colors[OTHER_SERIES_ID]).toBeUndefined()
    expect(colors[4]).toBeDefined()
  })

  it("assigns every slot once when the palette is exactly filled", () => {
    const colors = assignSeriesColors(series(1, 2, 3, 4, 5, 6, 7, 8), PALETTE)
    expect(new Set(Object.values(colors)).size).toBe(PALETTE.length)
  })

  it("handles a negative id without indexing off the palette", () => {
    const colors = assignSeriesColors(series(-42), PALETTE)
    expect(PALETTE).toContain(colors[-42])
  })
})
