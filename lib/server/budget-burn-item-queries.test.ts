import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const querySource = readFileSync(join(process.cwd(), "lib/server/budget-burn-item-queries.ts"), "utf8")
const routeSource = readFileSync(join(process.cwd(), "app/api/v1/analytics/executive/budget-burn/item-comparison/route.ts"), "utf8")

describe("budget-burn item query contract", () => {
  it("stays line-grain, refund-aware, tenant-fenced and bounded", () => {
    expect(querySource).toContain('.from(orderItems)')
    expect(querySource).toContain('lineConditions(scope, filters)')
    expect(querySource).toContain('lineNetQuantity')
    expect(querySource).toContain('lineNetValue')
    expect(querySource).toContain('.groupBy(orderItems.globalProductId, orderItems.unit)')
    expect(querySource).toContain('.limit(BUDGET_BURN_ITEM_ROW_CAP)')
  })

  it("resolves scope and role before input-driven reads and hides raw errors", () => {
    const scope = routeSource.indexOf("resolveExecutiveScope")
    const role = routeSource.indexOf("isBudgetBurnRole(scope.role)")
    const oneBranch = routeSource.indexOf("scope.branchIds?.length !== 1")
    const validation = routeSource.indexOf("querySchema.safeParse")
    const load = routeSource.indexOf("loadProductWindow(scope")
    expect(scope).toBeGreaterThan(-1)
    expect(scope).toBeLessThan(role)
    expect(role).toBeLessThan(oneBranch)
    expect(oneBranch).toBeLessThan(validation)
    expect(validation).toBeLessThan(load)
    expect(routeSource).toContain('handleError(error, "EXECUTIVE_BUDGET_BURN_ITEM_COMPARISON")')
    expect(routeSource).not.toContain("error.message")
  })

  it("reads the same two trend windows the growth figure was built from", () => {
    // The panel exists to explain a percentage. Reading the selected month on
    // one side and the trend window on the other would make its totals
    // disagree with the figure that was clicked, silently.
    expect(routeSource).toContain("windowFilters(windows.trend.current, parsedQuery.data.userId)")
    expect(routeSource).toContain("windowFilters(windows.trend.prior, parsedQuery.data.userId)")
    expect(routeSource).not.toContain("windowFilters(windows.current")
    expect(routeSource).not.toContain("windowFilters(windows.prior")
  })
})
