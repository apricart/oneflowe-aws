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

/**
 * The branch list the group filter is folded from: two groups, one branch with
 * no group. Scoped per role by the endpoint, which is not under test here.
 */
const scopedBranches = [
  { id: 4, name: "Karachi", groupId: 5, groupName: "North" },
  { id: 8, name: "Hub", groupId: 5, groupName: "North" },
  { id: 9, name: "Gwadar", groupId: 6, groupName: "Coast" },
  { id: 3, name: "Head Office", groupId: null, groupName: null },
]

vi.mock("@/lib/hooks/use-api", () => ({
  useAPI: () => ({ data: { items: [] } }),
  useBranches: () => ({ data: { items: scopedBranches } }),
}))
// The neighbours are reduced to what this row hands them: the branch filter
// shows the groups it was told to narrow to, and every multi-select offers one
// button per option that picks exactly that option.
vi.mock("@/components/reports/branch-filter", () => ({
  BranchFilter: ({ groupIds }: any) => <div data-testid="branch-filter">{(groupIds ?? []).join(",")}</div>,
}))
vi.mock("@/components/reports/organization-filter", () => ({
  OrganizationFilter: ({ onChange }: any) => (
    <button type="button" onClick={() => onChange(["2"])}>Organization: Two</button>
  ),
}))
vi.mock("@/components/reports/multi-select-filter", () => ({
  MultiSelectFilter: ({ title, items, onChange }: any) => (
    <div>
      {items.map((item: any) => (
        <button key={item.id} type="button" onClick={() => onChange([item.id])}>{`${title}: ${item.label}`}</button>
      ))}
    </div>
  ),
}))

import { toCalendarDate } from "@/components/reports/quick-date-range"

import {
  ExecutiveFilters,
  executiveDefaultDates,
  groupOptionsFromBranches,
  toQuery,
  type ExecutiveFilterState,
} from "./executive-filters"

const baseFilters = (): ExecutiveFilterState => ({
  ...executiveDefaultDates(),
  organizationIds: [],
  groupIds: [],
  branchIds: [],
  categoryIds: [],
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

it("does not offer a unit filter", () => {
  render(<ExecutiveFilters role="HEAD_OFFICE" value={baseFilters()} onChange={() => {}} />)
  expect(screen.queryByLabelText("Unit")).toBeNull()
  expect(new URLSearchParams(toQuery(baseFilters())).has("unit")).toBe(false)
})

describe("date range filtering", () => {
  it("applies both ends of a picked range, not just the last one", () => {
    const harness = stateHarness(baseFilters())
    render(
      <ExecutiveFilters
        role="SUPER_ADMIN"
        value={harness.current}
        onChange={harness.onChange}
      />,
    )

    fireEvent.click(screen.getByText("Today"))

    const today = toCalendarDate(new Date())
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
      />,
    )

    const before = harness.current.startDate
    fireEvent.click(screen.getByText("7 Days"))

    expect(harness.current.startDate).not.toBe(before)
    const expected = new Date()
    expected.setDate(expected.getDate() - 6)
    expect(harness.current.startDate).toBe(toCalendarDate(expected))
  })

  it("carries the picked range into the query both endpoints receive", () => {
    const harness = stateHarness(baseFilters())
    render(
      <ExecutiveFilters
        role="SUPER_ADMIN"
        value={harness.current}
        onChange={harness.onChange}
      />,
    )

    fireEvent.click(screen.getByText("30 Days"))
    const query = new URLSearchParams(toQuery(harness.current, { dimension: "product" }))

    expect(query.get("startDate")).toBe(harness.current.startDate)
    expect(query.get("endDate")).toBe(harness.current.endDate)
    expect(query.get("dimension")).toBe("product")
  })

  it("leaves the other filters untouched when only the dates change", () => {
    const harness = stateHarness({ ...baseFilters(), branchIds: ["4"], categoryIds: ["9"] })
    render(
      <ExecutiveFilters
        role="SUPER_ADMIN"
        value={harness.current}
        onChange={harness.onChange}
      />,
    )

    fireEvent.click(screen.getByText("Today"))

    expect(harness.current.branchIds).toEqual(["4"])
    expect(harness.current.categoryIds).toEqual(["9"])
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

describe("the group filter", () => {
  const renderRow = (harness: ReturnType<typeof stateHarness>, role = "HEAD_OFFICE") => render(
    <ExecutiveFilters
      role={role}
      value={harness.current}
      onChange={harness.onChange}
    />,
  )

  it("offers one option per group that has a branch in scope, by name", () => {
    expect(groupOptionsFromBranches(scopedBranches)).toEqual([
      { id: "6", label: "Coast" },
      { id: "5", label: "North" },
    ])
    // A group whose name has not arrived is still offered, under its id.
    expect(groupOptionsFromBranches([{ groupId: 9, groupName: "  " }])).toEqual([{ id: "9", label: "Group #9" }])
    expect(groupOptionsFromBranches([])).toEqual([])
  })

  it("carries the chosen groups into the query every endpoint receives", () => {
    const harness = stateHarness(baseFilters())
    renderRow(harness)

    fireEvent.click(screen.getByText("Groups: North"))

    expect(harness.current.groupIds).toEqual(["5"])
    expect(new URLSearchParams(toQuery(harness.current)).get("groupIds")).toBe("5")
    expect(new URLSearchParams(toQuery(baseFilters())).has("groupIds")).toBe(false)
  })

  it("drops a picked branch when the groups change, since it may fall outside them", () => {
    const harness = stateHarness({ ...baseFilters(), branchIds: ["4"], categoryIds: ["21"] })
    renderRow(harness)

    fireEvent.click(screen.getByText("Groups: Coast"))

    expect(harness.current.groupIds).toEqual(["6"])
    expect(harness.current.branchIds).toEqual([])
    // Only the branch selection depends on the group; the rest stays.
    expect(harness.current.categoryIds).toEqual(["21"])
  })

  it("narrows the branch filter to the chosen groups", () => {
    const harness = stateHarness({ ...baseFilters(), groupIds: ["5", "6"] })
    renderRow(harness)
    expect(screen.getByTestId("branch-filter").textContent).toBe("5,6")
  })

  it("goes with the organization, and with Clear", () => {
    const changed = stateHarness({ ...baseFilters(), groupIds: ["5"], branchIds: ["4"] })
    const first = renderRow(changed, "SUPER_ADMIN")
    fireEvent.click(screen.getByText("Organization: Two"))
    expect(changed.current.organizationIds).toEqual(["2"])
    expect(changed.current.groupIds).toEqual([])
    expect(changed.current.branchIds).toEqual([])
    first.unmount()

    const cleared = stateHarness({ ...baseFilters(), groupIds: ["5"] })
    renderRow(cleared)
    fireEvent.click(screen.getByRole("button", { name: /Clear/ }))
    expect(cleared.current.groupIds).toEqual([])
  })
})
