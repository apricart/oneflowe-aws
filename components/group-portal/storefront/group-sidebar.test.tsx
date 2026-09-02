import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { GroupSidebar } from "@/components/group-portal/storefront/group-sidebar"
import type { BranchBudgetSummary, ScopedGroup } from "@/components/group-portal/types"

const airport = { id: 7, name: "Airport Branch", city: "karachi", costCenterId: null, groupId: 1 }
const dha = { id: 8, name: "DHA", city: "KARACHI", costCenterId: null, groupId: 1 }

const group: ScopedGroup = { id: 1, name: "Zoomato Products-1", branches: [airport, dha] }

/** A second group, so the cross-group search has somewhere else to look. */
const gulberg = { id: 21, name: "Gulberg Outlet", city: "Lahore", costCenterId: "CC-900", groupId: 2 }
const otherGroup: ScopedGroup = { id: 2, name: "Cafe Supplies", branches: [gulberg] }

const budget = (branchId: number, overrides: Partial<BranchBudgetSummary> = {}): BranchBudgetSummary => ({
  branchId,
  period: "2026-08",
  configured: true,
  totalCents: 5_000_000,
  spentCents: 0,
  heldCents: 0,
  remainingCents: 5_000_000,
  ...overrides,
})

function renderSidebar(overrides: Partial<Parameters<typeof GroupSidebar>[0]> = {}) {
  const onToggleBranch = vi.fn()

  render(
    <GroupSidebar
      groups={[group]}
      loading={false}
      failed={false}
      selectedGroupId={1}
      selectedBranchIds={[7, 8]}
      expandedGroupKey="1"
      onToggleExpand={vi.fn()}
      onToggleBranch={onToggleBranch}
      onSetGroupBranches={vi.fn()}
      {...overrides}
    />,
  )

  return { onToggleBranch }
}

/** The row a location's name and budget share. */
const locationRow = (name: string) =>
  screen.getByRole("checkbox", { name: `Order for ${name}` }).closest("label") as HTMLElement

describe("GroupSidebar location budgets", () => {
  afterEach(cleanup)

  it("shows remaining against total under each location", () => {
    renderSidebar({
      budgets: new Map([
        [7, budget(7, { spentCents: 1_000_000, heldCents: 500_000, remainingCents: 3_500_000 })],
        [8, budget(8, { remainingCents: 5_000_000 })],
      ]),
    })

    expect(locationRow("Airport Branch").textContent).toContain("35,000")
    expect(locationRow("Airport Branch").textContent).toContain("/ 50,000 left")
    expect(locationRow("DHA").textContent).toContain("/ 50,000 left")
  })

  it("says so when head office has not set a budget for the month", () => {
    renderSidebar({ budgets: new Map([[7, budget(7, { configured: false, totalCents: 0, remainingCents: 0 })]]) })

    expect(locationRow("Airport Branch").textContent).toContain("No budget set for this month")
  })

  it("shows no figure rather than an invented zero when budgets are unavailable", () => {
    // A budget that failed to load is not a budget of zero, and saying "0 left"
    // would send a requester to head office over a network blip.
    renderSidebar({ budgets: new Map(), budgetsLoading: false })

    const row = locationRow("Airport Branch")
    expect(row.textContent).not.toContain("left")
    expect(row.textContent).not.toContain("No budget set")
  })

  it("never gates ordering on the budget it displays", () => {
    // The server re-checks the real budget per location at submission and
    // reports a shortfall there; an exhausted location stays tickable so a
    // requester can still build and correct an order.
    const { onToggleBranch } = renderSidebar({
      budgets: new Map([[7, budget(7, { spentCents: 5_000_000, remainingCents: 0 })]]),
    })

    const checkbox = within(locationRow("Airport Branch")).getByRole("checkbox")
    expect(checkbox.hasAttribute("disabled")).toBe(false)

    fireEvent.click(checkbox)
    expect(onToggleBranch).toHaveBeenCalledWith(1, 7)
  })

  it("still disables every location while the order is being reviewed or sent", () => {
    renderSidebar({ disabled: true, budgets: new Map([[7, budget(7)]]) })

    expect(within(locationRow("Airport Branch")).getByRole("checkbox").hasAttribute("disabled")).toBe(true)
  })
})

/** Type into the sidebar's cross-group location finder. */
function searchFor(query: string) {
  fireEvent.change(
    screen.getByRole("searchbox", { name: /search locations across all your groups/i }),
    { target: { value: query } },
  )
}

describe("GroupSidebar cross-group location search", () => {
  afterEach(cleanup)

  const renderTwoGroups = (overrides: Partial<Parameters<typeof GroupSidebar>[0]> = {}) =>
    renderSidebar({ groups: [group, otherGroup], selectedBranchIds: [7], ...overrides })

  it("finds a location in a group the user is not ordering for", () => {
    renderTwoGroups()
    searchFor("gulberg")

    // Reached without ever opening its group, and labelled with the group it
    // belongs to so the move it implies is not a surprise.
    expect(screen.getByRole("checkbox", { name: "Order for Gulberg Outlet" })).toBeTruthy()
    expect(screen.getByText("Cafe Supplies")).toBeTruthy()
    // The other group's locations are out of scope for this query.
    expect(screen.queryByRole("checkbox", { name: "Order for DHA" })).toBeNull()
  })

  it("matches on city and cost centre, not just the branch name", () => {
    renderTwoGroups()

    searchFor("lahore")
    expect(screen.getByRole("checkbox", { name: "Order for Gulberg Outlet" })).toBeTruthy()

    searchFor("cc-900")
    expect(screen.getByRole("checkbox", { name: "Order for Gulberg Outlet" })).toBeTruthy()
  })

  it("shows a match outside the selected group as unticked, whatever the selection holds", () => {
    // One group at a time is a rule about what can be ordered, so a hit in
    // another group must never render as already part of this order - not even
    // when a stale id for it is still sitting in the selection.
    renderTwoGroups({ selectedBranchIds: [7, 21] })

    searchFor("branch")
    expect(screen.getByRole("checkbox", { name: "Order for Airport Branch" }).getAttribute("data-state"))
      .toBe("checked")

    searchFor("gulberg")
    expect(screen.getByRole("checkbox", { name: "Order for Gulberg Outlet" }).getAttribute("data-state"))
      .toBe("unchecked")
  })

  it("routes a search hit through the same toggle as the tree, with its own group id", () => {
    // This is what keeps the one-group rule intact: the caller receives the
    // hit's group, moves the selection there, and asks about the cart first.
    const { onToggleBranch } = renderTwoGroups()
    searchFor("gulberg")

    fireEvent.click(screen.getByRole("checkbox", { name: "Order for Gulberg Outlet" }))
    expect(onToggleBranch).toHaveBeenCalledWith(2, 21)
  })

  it("says when nothing matches instead of showing an empty tree", () => {
    renderTwoGroups()
    searchFor("nowhere")

    expect(screen.getByRole("status").textContent).toContain("No locations match")
    expect(screen.queryByRole("checkbox")).toBeNull()
  })

  it("restores the group tree when the search is cleared", () => {
    renderTwoGroups()
    searchFor("gulberg")
    fireEvent.click(screen.getByRole("button", { name: /clear location search/i }))

    expect(screen.getByRole("checkbox", { name: "Order for DHA" })).toBeTruthy()
    expect(screen.queryByRole("checkbox", { name: "Order for Gulberg Outlet" })).toBeNull()
  })

  it("cannot be searched while the order is being reviewed or sent", () => {
    renderTwoGroups({ disabled: true })

    expect(
      screen.getByRole("searchbox", { name: /search locations across all your groups/i })
        .hasAttribute("disabled"),
    ).toBe(true)
  })
})
