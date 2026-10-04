import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

/**
 * The control for `plans/OF-BUDGET-open-current-month-on-budget-list.md`.
 * Behaviour is carried by `lib/budget-period-opening.test.ts` (the rules) and
 * `tests/integration/budget-period-opening.test.ts` (the database); these pin
 * the structure that keeps the write inside the list's fence.
 */
describe("the Budgets list opens the current month before it reads", () => {
  const route = source("app/api/v1/budgets/route.ts")
  const loader = route.slice(
    route.indexOf("async function loadAggregatedMoneyBudgets"),
    route.indexOf("function addMoneyBudgetRemaining"),
  )

  it("opens the month inside the aggregated loader, keyed on the fenced branch list", () => {
    expect(loader).toContain("await openCurrentBudgetPeriodRows(db, { branchIds, requestedPeriods: range.periods })")
    // `branchIds` is derived from the rows the list's own scope returned.
    expect(loader).toMatch(/\.where\(context\.branchScope\)[\s\S]*const branchIds = activeBranches\.map/)
  })

  it("never lets a failed opening cost the caller the list", () => {
    expect(loader).toMatch(/try \{\s*await openCurrentBudgetPeriodRows\([^)]*\)\s*\} catch \(caughtError\) \{\s*logError\(caughtError, "BUDGETS_OPEN_CURRENT_PERIOD"\)/)
  })

  it("opens before the add-on settle and before the ledger read, so both see the new row", () => {
    const openAt = loader.indexOf("openCurrentBudgetPeriodRows(")
    expect(openAt).toBeGreaterThan(-1)
    expect(loader.indexOf("settleDueBudgetAddons(", openAt)).toBeGreaterThan(openAt)
    expect(loader.indexOf(".from(budgets)", openAt)).toBeGreaterThan(openAt)
  })
})

describe("the writer re-asserts the rule from the database", () => {
  const writer = source("lib/server/budget-period-opening.ts")

  it("opens only active branches of a budget-enabled tenant with a positive baseline", () => {
    expect(writer).toContain('eq(branches.status, "active")')
    expect(writer).toContain("gt(branches.baselineBudgetCents, 0)")
    expect(writer).toContain("budgetEnabledBranchSql()")
  })

  it("never overwrites a row that already exists", () => {
    expect(writer).toContain(".onConflictDoNothing()")
    expect(writer).not.toMatch(/\.update\(budgets\)/)
    expect(writer).not.toMatch(/onConflictDoUpdate/)
  })

  it("writes only the engine's own month", () => {
    expect(writer).toContain("if (period !== budgetPeriodOf(now)) return []")
  })
})
