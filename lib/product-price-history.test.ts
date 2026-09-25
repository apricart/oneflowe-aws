import { describe, expect, it } from "vitest"

import {
  isProductPriceHistoryRange,
  resolveProductPriceHistoryRange,
  toIsoTimestamp,
} from "@/lib/product-price-history"

describe("product price history ranges", () => {
  const now = new Date("2026-09-25T12:00:00.000Z")

  it("provides a readable label for each supported window", () => {
    expect(resolveProductPriceHistoryRange("90d", now)).toMatchObject({ label: "Last 90 days" })
    expect(resolveProductPriceHistoryRange("180d", now)).toMatchObject({ label: "Last 6 months" })
    expect(resolveProductPriceHistoryRange("1y", now)).toMatchObject({ label: "Last 12 months" })
    expect(resolveProductPriceHistoryRange("all", now)).toEqual({ key: "all", label: "All time", startAt: null })
  })

  it("calculates the range boundaries without mutating the supplied date", () => {
    expect(resolveProductPriceHistoryRange("90d", now).startAt?.toISOString()).toBe("2026-06-27T12:00:00.000Z")
    expect(resolveProductPriceHistoryRange("1y", now).startAt?.toISOString()).toBe("2025-09-25T12:00:00.000Z")
    expect(now.toISOString()).toBe("2026-09-25T12:00:00.000Z")
  })

  it("rejects unknown range keys", () => {
    expect(isProductPriceHistoryRange("90d")).toBe(true)
    expect(isProductPriceHistoryRange("quarter")).toBe(false)
    expect(isProductPriceHistoryRange(null)).toBe(false)
  })
})

describe("database timestamp normalization", () => {
  it("accepts both Date objects and PostgreSQL timestamp strings", () => {
    const expected = "2026-09-01T00:00:00.000Z"
    expect(toIsoTimestamp(new Date(expected))).toBe(expected)
    expect(toIsoTimestamp("2026-09-01 00:00:00+00")).toBe(expected)
  })

  it("returns null for absent or invalid database values", () => {
    expect(toIsoTimestamp(null)).toBeNull()
    expect(toIsoTimestamp(undefined)).toBeNull()
    expect(toIsoTimestamp("not-a-timestamp")).toBeNull()
  })
})
