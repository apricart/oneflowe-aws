import { describe, expect, it } from "vitest"

import {
  DEFAULT_TAX_RATE_BP,
  isHistoricalOnlyProduct,
  isValidTaxRateBp,
  resolveTaxRateBp,
  splitInclusiveCents,
  splitOrderInclusiveCents,
  taxRateBpToPercent,
  taxRatePercentToBp,
} from "./tax"

/**
 * The property the accounts team depends on is that splitting a price into net
 * and tax never changes what was charged. Every test here is ultimately about
 * that invariant, because it is what lets tax be introduced without restating a
 * single order total or disturbing any budget hold taken from one.
 */
describe("inclusive tax split", () => {
  it("splits a gross amount so the parts reconstruct it exactly", () => {
    expect(splitInclusiveCents(11_800, 1800)).toEqual({
      netCents: 10_000,
      taxCents: 1_800,
      grossCents: 11_800,
    })
  })

  it("keeps net + tax === gross for amounts that do not divide evenly", () => {
    for (const grossCents of [1, 7, 99, 333, 1_001, 12_345, 99_999, 1_234_567]) {
      const split = splitInclusiveCents(grossCents, DEFAULT_TAX_RATE_BP)
      expect(split.netCents + split.taxCents).toBe(grossCents)
      expect(split.netCents).toBeGreaterThanOrEqual(0)
      expect(split.taxCents).toBeGreaterThanOrEqual(0)
    }
  })

  it("treats a zero rate as wholly net so untaxed products record no tax", () => {
    expect(splitInclusiveCents(50_000, 0)).toEqual({
      netCents: 50_000,
      taxCents: 0,
      grossCents: 50_000,
    })
  })

  it("handles a zero-value line without inventing tax", () => {
    expect(splitInclusiveCents(0, DEFAULT_TAX_RATE_BP)).toEqual({
      netCents: 0,
      taxCents: 0,
      grossCents: 0,
    })
  })

  it("rejects inputs that would silently produce a wrong split", () => {
    expect(() => splitInclusiveCents(-1, DEFAULT_TAX_RATE_BP)).toThrow()
    expect(() => splitInclusiveCents(1.5, DEFAULT_TAX_RATE_BP)).toThrow()
    expect(() => splitInclusiveCents(100, -1)).toThrow()
    expect(() => splitInclusiveCents(100, 10_001)).toThrow()
    expect(() => splitInclusiveCents(100, 18.5)).toThrow()
  })
})

describe("whole-order split", () => {
  it("sums line components without drifting from the order gross", () => {
    const lines = [
      { grossCents: 333, taxRateBp: 1800 },
      { grossCents: 1_007, taxRateBp: 1800 },
      { grossCents: 89, taxRateBp: 1800 },
    ]
    const totals = splitOrderInclusiveCents(lines)

    expect(totals.grossCents).toBe(1_429)
    expect(totals.netCents + totals.taxCents).toBe(totals.grossCents)
  })

  it("reconciles when lines carry different rates", () => {
    const totals = splitOrderInclusiveCents([
      { grossCents: 11_800, taxRateBp: 1800 },
      { grossCents: 5_000, taxRateBp: 0 },
      { grossCents: 2_175, taxRateBp: 1750 },
    ])

    expect(totals.netCents + totals.taxCents).toBe(totals.grossCents)
    expect(totals.grossCents).toBe(18_975)
    expect(totals.lines[1]).toEqual({ netCents: 5_000, taxCents: 0, grossCents: 5_000 })
  })

  it("produces a zero split for an empty order rather than failing", () => {
    expect(splitOrderInclusiveCents([])).toEqual({
      lines: [],
      netCents: 0,
      taxCents: 0,
      grossCents: 0,
    })
  })
})

describe("rate resolution", () => {
  it("prefers the product override over the organization rate", () => {
    expect(resolveTaxRateBp(0, 1800)).toBe(0)
    expect(resolveTaxRateBp(1750, 1800)).toBe(1750)
  })

  it("falls back to the organization rate when a product has no override", () => {
    expect(resolveTaxRateBp(null, 1800)).toBe(1800)
    expect(resolveTaxRateBp(undefined, 1600)).toBe(1600)
  })

  it("falls back to 18% when neither level has a usable rate", () => {
    expect(resolveTaxRateBp(null, null)).toBe(DEFAULT_TAX_RATE_BP)
    expect(resolveTaxRateBp("18", "18")).toBe(DEFAULT_TAX_RATE_BP)
    expect(resolveTaxRateBp(-1, 20_000)).toBe(DEFAULT_TAX_RATE_BP)
  })
})

describe("rate entry", () => {
  it("reads a percentage the way a human types it", () => {
    expect(taxRatePercentToBp(18)).toBe(1800)
    expect(taxRatePercentToBp(0)).toBe(0)
    expect(taxRatePercentToBp(17.5)).toBe(1750)
    expect(taxRateBpToPercent(1800)).toBe(18)
  })

  it("refuses values that cannot be represented exactly", () => {
    expect(taxRatePercentToBp(18.005)).toBeNull()
    expect(taxRatePercentToBp(101)).toBeNull()
    expect(taxRatePercentToBp(-1)).toBeNull()
    expect(taxRatePercentToBp("18")).toBeNull()
  })

  it("validates stored basis points", () => {
    expect(isValidTaxRateBp(1800)).toBe(true)
    expect(isValidTaxRateBp(0)).toBe(true)
    expect(isValidTaxRateBp(10_000)).toBe(true)
    expect(isValidTaxRateBp(10_001)).toBe(false)
    expect(isValidTaxRateBp(1800.5)).toBe(false)
  })
})

/**
 * The marker identifies a product priced *excluding* tax, which the inclusive
 * split would misread; it is what stops someone activating one by hand. No
 * product carries it today — K-Electric's export turned out to be tax-inclusive
 * — so these cases cover the detector itself rather than any live data.
 */
describe("legacy product detection", () => {
  it("recognises the marker written by the K-Electric import", () => {
    expect(isHistoricalOnlyProduct({
      legacySource: "ke-electric",
      normalizedName: "cable",
      historicalOnly: true,
    })).toBe(true)
  })

  it("treats ordinary catalogue products as inclusive-priced", () => {
    expect(isHistoricalOnlyProduct({})).toBe(false)
    expect(isHistoricalOnlyProduct(null)).toBe(false)
    expect(isHistoricalOnlyProduct(undefined)).toBe(false)
    expect(isHistoricalOnlyProduct({ historicalOnly: false })).toBe(false)
    expect(isHistoricalOnlyProduct({ historicalOnly: "true" })).toBe(false)
  })
})
