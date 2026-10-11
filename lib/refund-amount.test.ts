import { describe, expect, it } from "vitest"

import { calculateLineCents } from "./quantity"
import { refundDetailsStillPriced, refundHistoryByLine, refundLineAmountCents } from "./refund-amount"

const none = { quantity: 0, amountCents: 0 }

/** Refund a line piece by piece, the way the refund routes price each refund. */
function refundInPieces(priceCents: number, lineQuantity: number, pieces: number[]): number[] {
  let already = none
  return pieces.map((refundQuantity) => {
    const amount = refundLineAmountCents({ priceCents, lineQuantity, already, refundQuantity })
    already = { quantity: already.quantity + refundQuantity, amountCents: already.amountCents + amount }
    return amount
  })
}

describe("refundLineAmountCents", () => {
  it("prices a refund that leaves units behind as the order priced them", () => {
    expect(refundLineAmountCents({ priceCents: 1_180, lineQuantity: 3, already: none, refundQuantity: 1 })).toBe(1_180)
    expect(refundLineAmountCents({ priceCents: 333, lineQuantity: 2, already: none, refundQuantity: 0.5 })).toBe(167)
  })

  it("gives back exactly what the line charged once it is refunded in full", () => {
    // 103 × 0.3 charged 31; three refunds of 0.1 each used to give back 10.
    expect(refundInPieces(103, 0.3, [0.1, 0.1, 0.1])).toEqual([10, 10, 11])
    // 101 × 1.5 charged 152; three refunds of 0.5 each used to ask for 51, so
    // the last half unit could not be refunded at all (51 > 50 left).
    expect(refundInPieces(101, 1.5, [0.5, 0.5, 0.5])).toEqual([51, 51, 50])
  })

  it("adds up to the line's charge however the line is cut", () => {
    for (let priceCents = 1; priceCents < 3_000; priceCents += 7) {
      for (const pieces of [[0.5, 0.5, 0.5, 0.5], [1.5, 0.5], [0.5, 1, 0.5], [2]]) {
        const lineQuantity = pieces.reduce((sum, piece) => sum + piece, 0)
        const amounts = refundInPieces(priceCents, lineQuantity, pieces)
        expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(calculateLineCents(priceCents, lineQuantity))
        expect(amounts.every((amount) => amount >= 0)).toBe(true)
      }
    }
  })

  it("never gives back more than is left of the line", () => {
    expect(refundLineAmountCents({ priceCents: 101, lineQuantity: 1.5, already: { quantity: 0.5, amountCents: 150 }, refundQuantity: 0.5 })).toBe(2)
    expect(refundLineAmountCents({ priceCents: 101, lineQuantity: 1.5, already: { quantity: 0.5, amountCents: 999 }, refundQuantity: 0.5 })).toBe(0)
  })

  it("treats floating-point quantities that sum to the line as the last refund", () => {
    expect(refundLineAmountCents({ priceCents: 103, lineQuantity: 0.3, already: { quantity: 0.1 + 0.1, amountCents: 20 }, refundQuantity: 0.1 })).toBe(11)
  })
})

describe("refundHistoryByLine", () => {
  it("sums quantity and money per line, reading numbers stored as strings", () => {
    const history = refundHistoryByLine([
      { orderItemId: 1, quantity: "0.5", amountCents: "51" },
      { orderItemId: 1, quantity: 0.5, amountCents: 51 },
      { orderItemId: 2, quantity: 1, amountCents: null },
    ])
    expect(history.get(1)).toEqual({ quantity: 1, amountCents: 102 })
    expect(history.get(2)).toEqual({ quantity: 1, amountCents: 0 })
  })
})

describe("refundDetailsStillPriced", () => {
  const lines = new Map([[1, { priceCents: 101, quantity: 1.5 }]])

  it("accepts details priced against the history read under the lock", () => {
    const history = refundHistoryByLine([{ orderItemId: 1, quantity: 0.5, amountCents: 51 }])
    expect(refundDetailsStillPriced([{ orderItemId: 1, quantity: 0.5, amountCents: 51 }], lines, history)).toBe(true)
  })

  it("refuses details a concurrent refund made stale: this one now takes the last units", () => {
    // Priced when only 0.5 had been refunded; another 0.5 committed since.
    const history = refundHistoryByLine([
      { orderItemId: 1, quantity: 0.5, amountCents: 51 },
      { orderItemId: 1, quantity: 0.5, amountCents: 51 },
    ])
    expect(refundDetailsStillPriced([{ orderItemId: 1, quantity: 0.5, amountCents: 51 }], lines, history)).toBe(false)
  })

  it("refuses a line that is not on the order", () => {
    expect(refundDetailsStillPriced([{ orderItemId: 9, quantity: 1, amountCents: 1 }], lines, new Map())).toBe(false)
  })
})
