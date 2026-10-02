import { describe, expect, it } from "vitest"
import {
  ALL_MONTHS,
  DEFAULT_REFRESH_INTERVAL_MS,
  REFRESH_CHOICES,
  availableCostYears,
  costChartGranularity,
  describeCostPeriod,
  describeLastUpdated,
  normalizeMonths,
  refreshChoiceFor,
} from "@/lib/viewer-dashboard"

describe("availableCostYears", () => {
  const now = new Date("2026-09-29T10:00:00Z")

  it("runs from the first order's year back-to-front", () => {
    expect(availableCostYears("2024-03-01T00:00:00Z", now)).toEqual([2026, 2025, 2024])
  })

  it("gives the current year alone when the tenant has one year of history", () => {
    expect(availableCostYears("2026-01-04T00:00:00Z", now)).toEqual([2026])
  })

  it("falls back to the current year for a missing or unparseable date", () => {
    expect(availableCostYears(null, now)).toEqual([2026])
    expect(availableCostYears(undefined, now)).toEqual([2026])
    expect(availableCostYears("not a date", now)).toEqual([2026])
  })

  it("never runs forward from a future earliest date", () => {
    expect(availableCostYears("2030-01-01T00:00:00Z", now)).toEqual([2026])
  })

  it("clamps an absurdly old date rather than listing a thousand years", () => {
    expect(availableCostYears("1801-01-01T00:00:00Z", now)).toHaveLength(27)
  })
})

describe("normalizeMonths", () => {
  it("de-duplicates, sorts and drops anything out of range", () => {
    expect(normalizeMonths([12, 1, 1, 0, 13, -2, "3", null, "x"])).toEqual([1, 3, 12])
  })

  it("keeps an empty selection empty", () => {
    expect(normalizeMonths([])).toEqual([])
  })
})

describe("describeCostPeriod", () => {
  it("names the year alone for no months and for all twelve", () => {
    expect(describeCostPeriod({ year: 2026, months: [] })).toBe("2026")
    expect(describeCostPeriod({ year: 2026, months: [...ALL_MONTHS] })).toBe("2026")
  })

  it("names a single month in full", () => {
    expect(describeCostPeriod({ year: 2026, months: [9] })).toBe("September 2026")
  })

  it("lists several months short, in order", () => {
    expect(describeCostPeriod({ year: 2026, months: [7, 1, 3] })).toBe("Jan, Mar, Jul 2026")
  })
})

describe("costChartGranularity", () => {
  it("reads a single month day by day", () => {
    expect(costChartGranularity({ year: 2026, months: [9] })).toBe("daily")
  })

  it("reads anything wider month by month", () => {
    expect(costChartGranularity({ year: 2026, months: [] })).toBe("monthly")
    expect(costChartGranularity({ year: 2026, months: [8, 9] })).toBe("monthly")
    expect(costChartGranularity({ year: 2026, months: [...ALL_MONTHS] })).toBe("monthly")
  })
})

describe("the refresh cadences", () => {
  it("offers off plus four intervals, none faster than 30 seconds", () => {
    expect(REFRESH_CHOICES.map((choice) => choice.intervalMs)).toEqual([0, 30_000, 60_000, 300_000, 900_000])
    for (const choice of REFRESH_CHOICES) {
      expect(choice.intervalMs === 0 || choice.intervalMs >= 30_000).toBe(true)
    }
  })

  it("defaults to one of the offered cadences", () => {
    expect(REFRESH_CHOICES.map((choice) => choice.intervalMs)).toContain(DEFAULT_REFRESH_INTERVAL_MS)
  })

  it("falls back to off for an interval nobody offers", () => {
    expect(refreshChoiceFor(1234).intervalMs).toBe(0)
    expect(refreshChoiceFor(60_000).label).toBe("1 minute")
  })
})

describe("describeLastUpdated", () => {
  it("waits rather than printing a time it does not have", () => {
    expect(describeLastUpdated(null)).toBe("Loading…")
  })

  it("prints a zero-padded local clock time", () => {
    const at = new Date(2026, 8, 29, 9, 5, 3)
    expect(describeLastUpdated(at)).toBe("Updated 09:05:03")
  })
})
