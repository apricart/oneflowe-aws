import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { installDomPolyfills, installFetch } from "@/tests/support/ui-harness"

import { GlobalDateFilter, getPresetLabel, getPresetRange, monthPresets, presets } from "./global-date-filter"

/**
 * The date filter every report shares. The ranges each preset produces are
 * what the reports send to the server, so they are pinned against a fixed
 * clock; the component is then driven through its popover.
 */
const NOW = new Date(2026, 9, 6, 15, 30) // 6 Oct 2026, 15:30 local

beforeEach(() => {
  installDomPolyfills()
  installFetch([["/api/v1/analytics/earliest-record", { year: 2025 }]])
})
afterEach(() => {
  vi.useRealTimers()
})

describe("preset ranges", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW)
  })

  it("covers whole local days", () => {
    const today = getPresetRange("today")
    expect(today.startDate).toEqual(new Date(2026, 9, 6, 0, 0, 0, 0))
    expect(today.endDate).toEqual(new Date(2026, 9, 6, 23, 59, 59, 999))
  })

  it("counts today in the 3- and 7-day windows", () => {
    expect(getPresetRange("3d").startDate).toEqual(new Date(2026, 9, 4))
    expect(getPresetRange("7d").startDate).toEqual(new Date(2026, 8, 30))
  })

  it("spans the calendar month and year", () => {
    expect(getPresetRange("thisMonth")).toEqual({ startDate: new Date(2026, 9, 1), endDate: new Date(2026, 9, 31, 23, 59, 59, 999) })
    expect(getPresetRange("monthly")).toEqual(getPresetRange("thisMonth"))
    expect(getPresetRange("yearly").startDate).toEqual(new Date(2026, 0, 1))
    expect(getPresetRange("yearly").endDate).toEqual(new Date(2026, 11, 31, 23, 59, 59, 999))
  })

  it("maps each month preset to that month of the current year, including February's length", () => {
    expect(monthPresets).toHaveLength(12)
    const february = getPresetRange("feb")
    expect(february.startDate).toEqual(new Date(2026, 1, 1))
    expect(february.endDate).toEqual(new Date(2026, 1, 28, 23, 59, 59, 999))
    expect(getPresetRange("dec").endDate).toEqual(new Date(2026, 11, 31, 23, 59, 59, 999))
  })

  it("falls back to today for an unknown preset and to a fixed start for all time", () => {
    expect(getPresetRange("bogus" as never)).toEqual(getPresetRange("today"))
    expect(getPresetRange("all").endDate).toEqual(new Date(2026, 9, 6, 23, 59, 59, 999))
  })
})

describe("preset labels", () => {
  it("names every preset and formats a custom range", () => {
    for (const preset of [...presets, ...monthPresets]) expect(getPresetLabel(preset.id)).toBe(preset.label)
    expect(getPresetLabel("custom", { startDate: new Date(2026, 0, 2), endDate: new Date(2026, 1, 3) })).toBe("02 Jan 2026 – 03 Feb 2026")
    expect(getPresetLabel("custom")).toBe("Custom")
    expect(getPresetLabel("nope" as never)).toBe("Selected Period")
  })
})

describe("GlobalDateFilter", () => {
  it("reports the chosen preset and its range", async () => {
    const onChange = vi.fn()
    render(<GlobalDateFilter value={null} onChange={onChange} activePreset="all" />)
    fireEvent.click(screen.getAllByRole("button")[0])
    const sevenDays = await screen.findByText("7 Days")
    fireEvent.click(sevenDays)
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    const change = onChange.mock.calls.at(-1)![0]
    expect(change.preset).toBe("7d")
    expect(change.range.endDate.getTime() - change.range.startDate.getTime()).toBeGreaterThan(6 * 86_400_000)
  })

  it("shows the active preset's label on its trigger", () => {
    render(<GlobalDateFilter value={getPresetRange("thisMonth")} onChange={vi.fn()} activePreset="thisMonth" />)
    expect(screen.getAllByText(/This Month/).length).toBeGreaterThan(0)
  })

  it("renders a custom-range-only filter without presets", () => {
    render(<GlobalDateFilter value={null} onChange={vi.fn()} activePreset="custom" customRangeOnly hidePresets />)
    expect(screen.queryByText("7 Days")).toBeNull()
  })
})
