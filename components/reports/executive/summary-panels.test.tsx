import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { KpiRow, type ExecutiveKpis } from "./summary-panels"

/**
 * The KPI row must never present a tenant with budget allocation switched off
 * as a budget of nothing: no zero budget, no negative remaining, no "Over the
 * allocated budget", no "no budget allocated" — it says the budget is off.
 */

const kpis = (overrides: Partial<ExecutiveKpis> = {}): ExecutiveKpis => ({
  totalBudgetCents: 0,
  allocatedCents: 0,
  creditedCents: 0,
  spentCents: 0,
  heldCents: 0,
  consumedCents: 0,
  remainingCents: 0,
  utilizationPct: 0,
  varianceCents: 0,
  spendCents: 150_000,
  orderCount: 3,
  avgOrderValueCents: 50_000,
  consumedGrowthPct: null,
  spendGrowthPct: null,
  orderGrowthPct: null,
  ...overrides,
})

describe("KpiRow", () => {
  it("says budget allocation is off on every budget card, and keeps the order card", () => {
    render(<KpiRow kpis={kpis({ budgetTracking: "none" })} loading={false} />)

    expect(screen.getAllByText("Off")).toHaveLength(4)
    expect(screen.getAllByText("Budget allocation is off for this organization")).toHaveLength(4)
    expect(screen.queryByText("no budget")).toBeNull()
    expect(screen.queryByText(/Over the allocated budget/)).toBeNull()
    expect(screen.queryByText(/No budget allocated/)).toBeNull()
    expect(screen.getByText("Orders")).toBeTruthy()
    expect(screen.getByText("3")).toBeTruthy()
  })

  it("shows the budget figures as before when every tenant tracks budgets", () => {
    render(<KpiRow kpis={kpis({ budgetTracking: "all", totalBudgetCents: 100_000, allocatedCents: 100_000, consumedCents: 40_000, remainingCents: 60_000, utilizationPct: 40 })} loading={false} />)

    expect(screen.queryByText("Off")).toBeNull()
    expect(screen.queryByText(/organizations with budget allocation off/)).toBeNull()
  })

  it("shows Consumed as one figure, never split into spent and committed", () => {
    render(<KpiRow kpis={kpis({ budgetTracking: "all", totalBudgetCents: 100_000, spentCents: 25_000, heldCents: 15_000, consumedCents: 40_000, remainingCents: 60_000, utilizationPct: 40 })} loading={false} />)

    expect(screen.queryByText(/spent/i)).toBeNull()
    expect(screen.queryByText(/committed/i)).toBeNull()
    expect(screen.getByText(/including orders awaiting approval/)).toBeTruthy()
  })

  it("keeps an older response without the field on the budget figures", () => {
    render(<KpiRow kpis={kpis()} loading={false} />)

    expect(screen.queryByText("Off")).toBeNull()
    expect(screen.getByText("no budget")).toBeTruthy()
  })

  it("says which tenants a mixed total leaves out", () => {
    render(<KpiRow kpis={kpis({ budgetTracking: "some", totalBudgetCents: 100_000, allocatedCents: 100_000 })} loading={false} />)

    expect(screen.getByText(/organizations with budget allocation off are not included/)).toBeTruthy()
  })
})
