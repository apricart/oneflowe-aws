import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeAll, describe, expect, it } from "vitest"

import {
  BranchCategoryHeatmap,
  BudgetVsActualChart,
  PriceVariancePanel,
  StatusCompositionChart,
  UtilizationRankingChart,
  type BranchRow,
} from "./overview-charts"

/**
 * These cover the states a chart must not render misleadingly: no data, a
 * single branch, a branch with no budget, and a comparison that is not possible.
 * Recharts draws nothing in jsdom, so the assertions run against the table view
 * and the explanatory copy — which is also the path a screen reader takes.
 */

// Recharts' ResponsiveContainer observes its box; jsdom has no ResizeObserver.
// The stub lets the components mount so the table view and copy can be read.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const branch = (over: Partial<BranchRow> = {}): BranchRow => ({
  branchId: 1,
  branchName: "Airport Branch",
  totalBudgetCents: 12_007_000,
  allocatedCents: 12_000_000,
  creditedCents: 7_000,
  spentCents: 83_000,
  heldCents: 645_000,
  consumedCents: 728_000,
  remainingCents: 11_279_000,
  utilizationPct: 6.06,
  health: "underused",
  spendCents: 587_000,
  orderCount: 12,
  avgOrderValueCents: 48_917,
  spendGrowthPct: 12,
  shareOfSpendPct: 68,
  ...over,
})

function showTable(title: string) {
  fireEvent.click(screen.getByLabelText(`Show ${title} as a table`))
}

describe("Budget vs Consumed", () => {
  it("explains an empty period instead of drawing an empty axis", () => {
    render(<BudgetVsActualChart rows={[]} loading={false} error={null} />)
    expect(screen.getByText(/no branch in the selected period has a budget/i)).toBeTruthy()
  })

  it("reports a branch with no budget as such rather than as 0%", () => {
    render(
      <BudgetVsActualChart
        rows={[branch({ totalBudgetCents: 0, allocatedCents: 0, creditedCents: 0, remainingCents: -728_000, health: "unbudgeted" })]}
        loading={false}
        error={null}
      />,
    )
    showTable("Budget vs Consumed by Branch")
    expect(within(screen.getByRole("table")).getByText("no budget")).toBeTruthy()
  })

  it("surfaces the exact figures in the table view", () => {
    render(<BudgetVsActualChart rows={[branch()]} loading={false} error={null} />)
    showTable("Budget vs Consumed by Branch")
    const table = within(screen.getByRole("table"))
    expect(table.getByText("Airport Branch")).toBeTruthy()
    expect(table.getByText("6.1%")).toBeTruthy()
  })
})

describe("Utilization ranking", () => {
  it("refuses to rank when nothing in scope has a budget", () => {
    render(
      <UtilizationRankingChart
        rows={[branch({ totalBudgetCents: 0, health: "unbudgeted" })]}
        warningPct={90}
        loading={false}
        error={null}
      />,
    )
    expect(screen.getByText(/no branch in scope has an allocated budget/i)).toBeTruthy()
  })

  it("names unbudgeted branches separately rather than ranking them at zero", () => {
    render(
      <UtilizationRankingChart
        rows={[branch(), branch({ branchId: 2, branchName: "DHA", totalBudgetCents: 0, health: "unbudgeted" })]}
        warningPct={90}
        loading={false}
        error={null}
      />,
    )
    expect(screen.getByText(/Not ranked — no budget set for this period: DHA/)).toBeTruthy()
  })

  it("labels every status band in words, not colour alone", () => {
    render(<UtilizationRankingChart rows={[branch()]} warningPct={90} loading={false} error={null} />)
    expect(screen.getByText("On track (< 90%)")).toBeTruthy()
    expect(screen.getByText("Over budget (> 100%)")).toBeTruthy()
  })
})

describe("Branch × Category mix", () => {
  it("declines to compare a mix when only one branch has activity", () => {
    render(
      <BranchCategoryHeatmap
        matrix={{
          categories: [{ key: "2", name: "Soda" }],
          rows: [{
            branchId: 1,
            branchName: "Airport Branch",
            totalCents: 533_000,
            cells: [{ categoryKey: "2", valueCents: 533_000, quantity: 59, sharePct: 100 }],
          }],
        }}
        loading={false}
        error={null}
      />,
    )
    expect(screen.getByText(/needs at least two branches/i)).toBeTruthy()
  })

  it("prints the share in every cell so the grid reads without colour", () => {
    render(
      <BranchCategoryHeatmap
        matrix={{
          categories: [{ key: "2", name: "Soda" }],
          rows: [
            { branchId: 1, branchName: "Airport", totalCents: 100, cells: [{ categoryKey: "2", valueCents: 90, quantity: 9, sharePct: 90 }] },
            { branchId: 2, branchName: "DHA", totalCents: 100, cells: [{ categoryKey: "2", valueCents: 40, quantity: 4, sharePct: 40 }] },
          ],
        }}
        loading={false}
        error={null}
      />,
    )
    expect(screen.getByText("90%")).toBeTruthy()
    expect(screen.getByText("40%")).toBeTruthy()
  })
})

describe("Price variance", () => {
  it("says why a comparison is impossible instead of showing an empty chart", () => {
    render(<PriceVariancePanel rows={[]} thresholdPct={15} loading={false} error={null} />)
    expect(screen.getByText(/at least two branches/i)).toBeTruthy()
  })

  it("states that a spread is not by itself a saving", () => {
    render(
      <PriceVariancePanel
        rows={[{
          productId: 1,
          productName: "Next Cola",
          unit: "ltr",
          branchCount: 2,
          minUnitPriceCents: 12_000,
          maxUnitPriceCents: 15_000,
          avgUnitPriceCents: 13_000,
          spreadPct: 25,
          valueCents: 576_000,
        }]}
        thresholdPct={15}
        loading={false}
        error={null}
      />,
    )
    expect(screen.getByText(/not by itself a saving/i)).toBeTruthy()
    expect(screen.getByText("25% spread")).toBeTruthy()
  })
})

describe("Status composition", () => {
  it("folds an unrecognised status into Other rather than inventing a colour", () => {
    render(
      <StatusCompositionChart
        branches={[{
          branchId: 1,
          branchName: "Airport",
          totalOrders: 10,
          statuses: [
            { status: "PENDING", orderCount: 5, sharePct: 50 },
            { status: "SOMETHING_NEW", orderCount: 5, sharePct: 50 },
          ],
        }]}
        loading={false}
        error={null}
      />,
    )
    expect(screen.getByText("Other")).toBeTruthy()
    expect(screen.getByText("Pending approval")).toBeTruthy()
  })

  it("merges CANCELLED into the rejected bucket", () => {
    render(
      <StatusCompositionChart
        branches={[{
          branchId: 1,
          branchName: "Airport",
          totalOrders: 4,
          statuses: [
            { status: "REJECTED", orderCount: 2, sharePct: 50 },
            { status: "CANCELLED", orderCount: 2, sharePct: 50 },
          ],
        }]}
        loading={false}
        error={null}
      />,
    )
    showTable("Order Status Composition by Branch")
    const table = within(screen.getByRole("table"))
    expect(table.getByText("Rejected / cancelled")).toBeTruthy()
    expect(table.getByText("100%")).toBeTruthy()
  })
})
