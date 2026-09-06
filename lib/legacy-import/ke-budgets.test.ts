import { describe, expect, it } from "vitest"

import {
  budgetToCents,
  periodOf,
  planBranchBudgets,
  summarizeBudgets,
  type CurrentBudget,
  type LegacyLocationBudget,
} from "./ke-budgets"

function location(
  overrides: Partial<LegacyLocationBudget> & { ID: number },
): LegacyLocationBudget {
  return {
    Name: `Location ${overrides.ID}`,
    MonthlyBudget: 1000,
    BudgetTenureFrom: "2026-09-01T00:00:00",
    BudgetTenureTo: "2026-09-30T00:00:00",
    ...overrides,
  }
}

const pins = (...ids: number[]) =>
  new Map(ids.map((id) => [id, { branchId: id * 10, name: `Branch ${id}` }]))

describe("periodOf", () => {
  it("reads the month off the tenure start", () => {
    expect(periodOf("2026-09-01T00:00:00")).toBe("2026-09")
  })

  // Legacy sends naive local timestamps. Parsing through Date() would read them
  // as UTC and roll a month-start back into the previous month east of GMT.
  it("does not shift the month for a midnight tenure start", () => {
    expect(periodOf("2026-01-01T00:00:00")).toBe("2026-01")
    expect(periodOf("2026-12-01T00:00:00")).toBe("2026-12")
  })

  it("rejects unreadable and out-of-range values", () => {
    expect(periodOf(null)).toBeNull()
    expect(periodOf("")).toBeNull()
    expect(periodOf("not a date")).toBeNull()
    expect(periodOf("2026-13-01T00:00:00")).toBeNull()
  })
})

describe("budgetToCents", () => {
  it("converts whole currency units to cents", () => {
    expect(budgetToCents(900000)).toBe(90_000_000)
    expect(budgetToCents("21000")).toBe(2_100_000)
  })

  it("rejects absent and negative values", () => {
    expect(budgetToCents(null)).toBeNull()
    expect(budgetToCents("")).toBeNull()
    expect(budgetToCents(-1)).toBeNull()
    expect(budgetToCents("abc")).toBeNull()
  })
})

describe("planBranchBudgets", () => {
  it("plans one budget row per funded, pinned location", () => {
    const plan = planBranchBudgets(
      [location({ ID: 2, Name: "KE HOUSE", MonthlyBudget: 900000 })],
      pins(2),
      [],
    )
    expect(plan.creates).toEqual([{
      branchId: 20,
      branchName: "Branch 2",
      legacyLocationId: 2,
      period: "2026-09",
      amountAllocatedCents: 90_000_000,
    }])
  })

  it("skips a location legacy has not funded", () => {
    const plan = planBranchBudgets([location({ ID: 3, MonthlyBudget: 0 })], pins(3), [])
    expect(plan.creates).toHaveLength(0)
    expect(plan.skipped[0].reason).toBe("NO_BUDGET")
  })

  it("skips a location with no OneFlowe branch pinned to it", () => {
    const plan = planBranchBudgets([location({ ID: 4 })], pins(), [])
    expect(plan.creates).toHaveLength(0)
    expect(plan.skipped[0].reason).toBe("BRANCH_NOT_PINNED")
  })

  it("skips a location whose tenure cannot be read", () => {
    const plan = planBranchBudgets([location({ ID: 5, BudgetTenureFrom: null })], pins(5), [])
    expect(plan.creates).toHaveLength(0)
    expect(plan.skipped[0].reason).toBe("NO_TENURE")
  })

  it("counts an identical existing allocation as unchanged", () => {
    const current: CurrentBudget[] = [{ branchId: 20, period: "2026-09", amountAllocatedCents: 100_000 }]
    const plan = planBranchBudgets([location({ ID: 2, MonthlyBudget: 1000 })], pins(2), current)
    expect(plan.creates).toHaveLength(0)
    expect(plan.drift).toHaveLength(0)
    expect(plan.unchanged).toBe(1)
  })

  // Never rewritten: budgets_values_valid_ck requires allocated + credited to
  // cover spent + held, so lowering an allocation to match legacy can fail
  // outright once spend exists.
  it("reports a differing allocation as drift instead of overwriting it", () => {
    const current: CurrentBudget[] = [{ branchId: 20, period: "2026-09", amountAllocatedCents: 500_000 }]
    const plan = planBranchBudgets([location({ ID: 2, MonthlyBudget: 1000 })], pins(2), current)
    expect(plan.creates).toHaveLength(0)
    expect(plan.drift).toEqual([{
      branchId: 20,
      branchName: "Branch 2",
      period: "2026-09",
      currentCents: 500_000,
      legacyCents: 100_000,
    }])
  })

  it("is idempotent: planning against its own result creates nothing", () => {
    const locations = [location({ ID: 2, MonthlyBudget: 1000 }), location({ ID: 3, MonthlyBudget: 2000 })]
    const first = planBranchBudgets(locations, pins(2, 3), [])
    expect(first.creates).toHaveLength(2)

    const applied: CurrentBudget[] = first.creates.map((entry) => ({
      branchId: entry.branchId,
      period: entry.period,
      amountAllocatedCents: entry.amountAllocatedCents,
    }))
    const second = planBranchBudgets(locations, pins(2, 3), applied)

    expect(second.creates).toHaveLength(0)
    expect(second.drift).toHaveLength(0)
    expect(second.unchanged).toBe(2)
  })

  it("keeps each branch's own period rather than assuming one month for all", () => {
    const plan = planBranchBudgets(
      [
        location({ ID: 2, BudgetTenureFrom: "2026-09-01T00:00:00" }),
        location({ ID: 3, BudgetTenureFrom: "2026-08-01T00:00:00" }),
      ],
      pins(2, 3),
      [],
    )
    expect(plan.creates.map((entry) => entry.period)).toEqual(["2026-09", "2026-08"])
  })
})

describe("summarizeBudgets", () => {
  it("totals what would be allocated", () => {
    const plan = planBranchBudgets(
      [
        location({ ID: 2, MonthlyBudget: 900000 }),
        location({ ID: 3, MonthlyBudget: 21000 }),
        location({ ID: 4, MonthlyBudget: 0 }),
      ],
      pins(2, 3, 4),
      [],
    )
    expect(summarizeBudgets(plan)).toEqual({
      fundedLocations: 2,
      toCreate: 2,
      unchanged: 0,
      drift: 0,
      skipped: 1,
      totalAllocatedCents: 92_100_000,
      periods: ["2026-09"],
    })
  })
})
