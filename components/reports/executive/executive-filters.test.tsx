import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The date filter silently did nothing for a while, and the reason was subtle
 * enough to be worth pinning.
 *
 * `QuickDateRange` reports a picked range as two separate calls in one event —
 * `onStartDateChange` then `onEndDateChange`. The filter row applied each one
 * against the state it had captured when it rendered, so the second call
 * rebuilt the state from the stale value and threw the first away. Only the end
 * date moved, and since the end date was already today, picking a range
 * appeared to do nothing at all.
 *
 * These tests drive the real control and assert on the *composed* result, which
 * is the only thing that would have caught it.
 */

vi.mock("@/lib/hooks/use-api", () => ({ useAPI: () => ({ data: { items: [] } }) }))
vi.mock("@/components/reports/branch-filter", () => ({ BranchFilter: () => null }))
vi.mock("@/components/reports/organization-filter", () => ({ OrganizationFilter: () => null }))
vi.mock("@/components/reports/multi-select-filter", () => ({ MultiSelectFilter: () => null }))

import { toCalendarDate } from "@/components/reports/quick-date-range"

import { ExecutiveFilters, executiveDefaultDates, toQuery, type ExecutiveFilterState } from "./executive-filters"

const baseFilters = (): ExecutiveFilterState => ({
  ...executiveDefaultDates(),
  organizationIds: [],
  branchIds: [],
  categoryIds: [],
  unit: null,
})

/**
 * Stands in for the page's `useState`: applies every updater in order, exactly
 * as React would batch them within one event.
 */
function stateHarness(initial: ExecutiveFilterState) {
  let state = initial
  const onChange = (updater: (current: ExecutiveFilterState) => ExecutiveFilterState) => {
    state = updater(state)
  }
  return { onChange, get current() { return state } }
}

beforeEach(() => {
  window.localStorage.clear()
})

describe("date range filtering", () => {
  it("applies both ends of a picked range, not just the last one", () => {
    const harness = stateHarness(baseFilters())
    render(
      <ExecutiveFilters
        role="SUPER_ADMIN"
        value={harness.current}
        onChange={harness.onChange}
        availableUnits={[]}
        unitConflict={false}
      />,
    )

    fireEvent.click(screen.getByText("Today"))

    const today = new Date().toISOString().split("T")[0]
    expect(harness.current.startDate).toBe(today)
    expect(harness.current.endDate).toBe(today)
  })

  it("moves the start date when a range shares today as its end", () => {
    // The exact shape of the original bug: the end was already today, so an
    // implementation that drops the start change looks like a no-op.
    const harness = stateHarness(baseFilters())
    render(
      <ExecutiveFilters
        role="SUPER_ADMIN"
        value={harness.current}
        onChange={harness.onChange}
        availableUnits={[]}
        unitConflict={false}
      />,
    )

    const before = harness.current.startDate
    fireEvent.click(screen.getByText("7 Days"))

    expect(harness.current.startDate).not.toBe(before)
    const expected = new Date()
    expected.setDate(expected.getDate() - 6)
    expect(harness.current.startDate).toBe(expected.toISOString().split("T")[0])
  })

  it("carries the picked range into the query both endpoints receive", () => {
    const harness = stateHarness(baseFilters())
    render(
      <ExecutiveFilters
        role="SUPER_ADMIN"
        value={harness.current}
        onChange={harness.onChange}
        availableUnits={[]}
        unitConflict={false}
      />,
    )

    fireEvent.click(screen.getByText("30 Days"))
    const query = new URLSearchParams(toQuery(harness.current, { dimension: "product" }))

    expect(query.get("startDate")).toBe(harness.current.startDate)
    expect(query.get("endDate")).toBe(harness.current.endDate)
    expect(query.get("dimension")).toBe("product")
  })

  it("leaves the other filters untouched when only the dates change", () => {
    const harness = stateHarness({ ...baseFilters(), branchIds: ["4"], categoryIds: ["9"], unit: "kg" })
    render(
      <ExecutiveFilters
        role="SUPER_ADMIN"
        value={harness.current}
        onChange={harness.onChange}
        availableUnits={["kg", "ltr"]}
        unitConflict={false}
      />,
    )

    fireEvent.click(screen.getByText("Today"))

    expect(harness.current.branchIds).toEqual(["4"])
    expect(harness.current.categoryIds).toEqual(["9"])
    expect(harness.current.unit).toBe("kg")
  })
})

describe("the highlighted range matches the range applied", () => {
  it("opens on the same window the control marks as active", () => {
    const defaults = executiveDefaultDates()
    render(
      <ExecutiveFilters
        role="SUPER_ADMIN"
        value={{ ...baseFilters(), ...defaults }}
        onChange={() => {}}
        availableUnits={[]}
        unitConflict={false}
      />,
    )

    // "Quarter" is the executive default; it must be the pressed button, and
    // the dates the page opened with must be that quarter.
    const quarter = screen.getByText("Quarter")
    expect(quarter.className).toContain("bg-white")

    // The local calendar date, deliberately: the previous form of this
    // assertion went through `toISOString()`, which converts to UTC and, east of
    // Greenwich, names the day before the quarter began — so the test agreed
    // with a bug the control had.
    const now = new Date()
    const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)
    expect(defaults.startDate).toBe(toCalendarDate(quarterStart))
  })
})
