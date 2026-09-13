import { describe, expect, it } from "vitest"

import { getDateRange, toCalendarDate } from "./quick-date-range"

/**
 * The quick ranges are calendar dates in the reader's own timezone.
 *
 * They were built with `toISOString()`, which converts to UTC first. East of
 * Greenwich that turns local midnight on the 1st into the previous evening, so
 * "This Month" and "Quarter" started a day early for every reader in Pakistan
 * and "Today" meant yesterday until five in the morning. These run under
 * whatever timezone the machine has, so the assertions are written against the
 * local calendar rather than a fixed string.
 */

const local = (y: number, m: number, d: number) => new Date(y, m - 1, d, 0, 30)

describe("toCalendarDate", () => {
  it("formats the local calendar date, not the UTC one", () => {
    expect(toCalendarDate(local(2026, 7, 1))).toBe("2026-07-01")
    expect(toCalendarDate(local(2026, 1, 9))).toBe("2026-01-09")
  })
})

describe("getDateRange", () => {
  const now = local(2026, 9, 13)

  it("starts This Month on the 1st and Quarter on the quarter's first day, ending today", () => {
    expect(getDateRange("thisMonth", now)).toEqual({ start: "2026-09-01", end: "2026-09-13" })
    expect(getDateRange("thisQuarter", now)).toEqual({ start: "2026-07-01", end: "2026-09-13" })
  })

  it("counts today as the last of the 7 and 30 days", () => {
    expect(getDateRange("7days", now)).toEqual({ start: "2026-09-07", end: "2026-09-13" })
    expect(getDateRange("30days", now)).toEqual({ start: "2026-08-15", end: "2026-09-13" })
    expect(getDateRange("today", now)).toEqual({ start: "2026-09-13", end: "2026-09-13" })
  })

  it("holds at the 1st just after local midnight, where the UTC date has not caught up", () => {
    expect(getDateRange("thisMonth", local(2026, 10, 1))).toEqual({ start: "2026-10-01", end: "2026-10-01" })
    expect(getDateRange("thisQuarter", local(2026, 10, 1))).toEqual({ start: "2026-10-01", end: "2026-10-01" })
  })

  it("has no fixed range for custom", () => {
    expect(getDateRange("custom", now)).toBeNull()
  })
})
