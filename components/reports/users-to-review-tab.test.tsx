import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { BudgetBurnDrillSelection, BudgetBurnItemDrillSelection } from "./executive/budget-burn-watchlist"
import type { ExecutiveFilterState } from "./executive/executive-filters"

const captured = vi.hoisted(() => ({
  filters: null as ExecutiveFilterState | null,
}))

vi.mock("@/components/reports/organization-filter", () => ({
  OrganizationFilter: ({ selectedIds, onChange }: { selectedIds: string[]; onChange: (ids: string[]) => void }) => (
    <button type="button" onClick={() => onChange(["22"])}>Organization:{selectedIds.join(",") || "all"}</button>
  ),
}))

vi.mock("@/components/reports/group-filter", () => ({
  GroupFilter: ({ selectedIds, organizationIds, onChange }: {
    selectedIds: string[]
    organizationIds: string[]
    onChange: (ids: string[]) => void
  }) => (
    <button type="button" onClick={() => onChange(["33"])}>
      Group:{selectedIds.join(",") || "all"}:org-{organizationIds.join(",") || "all"}
    </button>
  ),
}))

vi.mock("@/components/reports/branch-filter", () => ({
  BranchFilter: ({ selectedIds, groupIds, onChange }: {
    selectedIds: string[]
    groupIds: string[]
    onChange: (ids: string[]) => void
  }) => (
    <button type="button" onClick={() => onChange(["44"])}>
      Branch:{selectedIds.join(",") || "all"}:group-{groupIds.join(",") || "all"}
    </button>
  ),
}))

const drillSelection: BudgetBurnDrillSelection = {
  target: { dimension: "user", key: "user-1", label: "User One", narrow: { branchIds: ["44"] } },
  filters: {
    startDate: "2026-09-01",
    endDate: "2026-09-27",
    organizationIds: ["11"],
    groupIds: ["33"],
    branchIds: ["44"],
    categoryIds: [],
  },
  statuses: "consumed",
  month: "2026-09",
  requesterName: "User One",
  branchName: "Branch 44",
  spendCents: 100,
  pendingCents: 20,
  pendingOrderCount: 1,
}

const itemSelection: BudgetBurnItemDrillSelection = {
  userId: "user-1",
  branchId: 44,
  requesterName: "User One",
  branchName: "Branch 44",
  month: "2026-09",
}

vi.mock("@/components/reports/executive/budget-burn-watchlist", () => ({
  BudgetBurnWatchlist: ({ filters, onDrill, onDrillItems }: {
    filters: ExecutiveFilterState
    onDrill: (selection: BudgetBurnDrillSelection) => void
    onDrillItems: (selection: BudgetBurnItemDrillSelection) => void
  }) => {
    captured.filters = filters
    return (
      <div data-testid="watchlist">
        <button type="button" onClick={() => onDrill(drillSelection)}>Open order lines</button>
        <button type="button" onClick={() => onDrillItems(itemSelection)}>Open item comparison</button>
      </div>
    )
  },
  BudgetBurnDrillNote: () => <div data-testid="drill-note" />,
}))

vi.mock("@/components/reports/executive/budget-burn-item-comparison", () => ({
  BudgetBurnItemComparisonPanel: () => <div data-testid="item-comparison" />,
}))

vi.mock("@/components/reports/executive/drill-down-panel", () => ({
  DrillDownPanel: () => <div data-testid="drill-down" />,
}))

vi.mock("@/components/reports/executive/chart-kit", () => ({
  ExecutiveVizStyles: () => null,
  VIZ_CLASS: "executive-viz",
}))

import { UsersToReviewTab } from "./users-to-review-tab"

beforeEach(() => {
  captured.filters = null
})

describe("UsersToReviewTab", () => {
  it.each(["GROUP_USER", "BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_ORDER_PORTAL", undefined])(
    "renders no feature for %s",
    (role) => {
      const { container } = render(<UsersToReviewTab role={role} organizationId={11} branchIds={["12"]} />)
      expect(container.innerHTML).toBe("")
      expect(captured.filters).toBeNull()
    },
  )

  it("shows all scope filters to Super Admin and carries their values to the watchlist", () => {
    render(<UsersToReviewTab role="SUPER_ADMIN" organizationId={11} branchIds={["12", "13"]} />)

    expect(screen.getByRole("button", { name: "Organization:11" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Group:all:org-11" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Branch:12,13:group-all" })).toBeTruthy()
    expect(captured.filters).toMatchObject({
      organizationIds: ["11"],
      groupIds: [],
      branchIds: ["12", "13"],
      categoryIds: [],
    })
  })

  it("keeps Head Office organization-scoped without offering a cross-tenant selector", () => {
    render(<UsersToReviewTab role="HEAD_OFFICE" organizationId={11} />)

    expect(screen.queryByRole("button", { name: /Organization:/ })).toBeNull()
    expect(screen.getByRole("button", { name: "Group:all:org-11" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Branch:all:group-all" })).toBeTruthy()
    expect(captured.filters?.organizationIds).toEqual(["11"])
  })

  it("cascades organization, group, and branch changes and resets to the page scope", () => {
    render(<UsersToReviewTab role="SUPER_ADMIN" organizationId={11} branchIds={["12"]} />)

    fireEvent.click(screen.getByRole("button", { name: "Organization:11" }))
    expect(captured.filters).toMatchObject({ organizationIds: ["22"], groupIds: [], branchIds: [] })

    fireEvent.click(screen.getByRole("button", { name: "Group:all:org-22" }))
    expect(captured.filters).toMatchObject({ organizationIds: ["22"], groupIds: ["33"], branchIds: [] })

    fireEvent.click(screen.getByRole("button", { name: "Branch:all:group-33" }))
    expect(captured.filters).toMatchObject({ organizationIds: ["22"], groupIds: ["33"], branchIds: ["44"] })

    fireEvent.click(screen.getByRole("button", { name: "Reset review filters" }))
    expect(captured.filters).toMatchObject({ organizationIds: ["11"], groupIds: [], branchIds: ["12"] })
  })

  it("closes stale details when the review scope changes", () => {
    render(<UsersToReviewTab role="HEAD_OFFICE" organizationId={11} />)

    fireEvent.click(screen.getByRole("button", { name: "Open order lines" }))
    fireEvent.click(screen.getByRole("button", { name: "Open item comparison" }))
    expect(screen.getByTestId("drill-down")).toBeTruthy()
    expect(screen.getByTestId("item-comparison")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Group:all:org-11" }))
    expect(screen.queryByTestId("drill-down")).toBeNull()
    expect(screen.queryByTestId("item-comparison")).toBeNull()
  })
})
