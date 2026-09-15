import { describe, expect, it } from "vitest"

import {
  budgetToCents,
  periodOf,
  planBranchBudgets,
  planZeroBudgets,
  summarizeBudgets,
  type BudgetBranch,
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

function current(
  overrides: Partial<CurrentBudget> & { branchId: number; amountAllocatedCents: number },
): CurrentBudget {
  return {
    period: "2026-09",
    amountCreditedCents: 0,
    amountSpentCents: 0,
    amountHeldCents: 0,
    ...overrides,
  }
}

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

  it("skips a location legacy has not funded when we hold no row for it either", () => {
    const plan = planBranchBudgets([location({ ID: 3, MonthlyBudget: 0, TotalBudget: 0 })], pins(3), [])
    expect(plan.creates).toHaveLength(0)
    expect(plan.skipped[0].reason).toBe("NO_BUDGET")
  })

  // MEGA CENTER: legacy 0/0, OneFlowe 35,000 with nothing used. Legacy says
  // the allocation is zero, so the row is compared rather than ignored.
  it("reports an allocation we hold for a location legacy has not funded", () => {
    const plan = planBranchBudgets(
      [location({ ID: 3, MonthlyBudget: 0, TotalBudget: 0 })],
      pins(3),
      [current({ branchId: 30, amountAllocatedCents: 3_500_000 })],
    )
    expect(plan.skipped).toHaveLength(0)
    expect(plan.drift).toEqual([expect.objectContaining({ currentCents: 3_500_000, legacyCents: 0, reason: "LOWER_NOT_REQUESTED" })])
  })

  it("lowers such an allocation to zero when asked", () => {
    const plan = planBranchBudgets(
      [location({ ID: 3, MonthlyBudget: 0, TotalBudget: 0 })],
      pins(3),
      [current({ branchId: 30, amountAllocatedCents: 3_500_000 })],
      { allowLower: true },
    )
    expect(plan.lowers).toEqual([expect.objectContaining({ currentCents: 3_500_000, amountAllocatedCents: 0 })])
  })

  // A location with no monthly figure that has spent everything reads 0/0 in
  // legacy too; its allocation is what was used, which is where the row sits.
  it("keeps a fully spent row whose legacy location shows nothing left", () => {
    const plan = planBranchBudgets(
      [location({ ID: 3, MonthlyBudget: 0, TotalBudget: 0 })],
      pins(3),
      [current({ branchId: 30, amountAllocatedCents: 2_000_000, amountSpentCents: 2_000_000 })],
      { allowLower: true },
    )
    expect(plan.unchanged).toBe(1)
    expect(plan.lowers).toHaveLength(0)
    expect(plan.drift).toHaveLength(0)
  })

  // HSEQ & Quality control: MonthlyBudget 0, TotalBudget 5, and 64,995 spent
  // in our ledger. The allocation is what is left plus what was used.
  it("derives the allocation from what is left plus our used when legacy has no monthly figure", () => {
    const plan = planBranchBudgets(
      [location({ ID: 80, MonthlyBudget: 0, TotalBudget: 5 })],
      pins(80),
      [current({ branchId: 800, amountAllocatedCents: 6_499_500, amountSpentCents: 6_499_500 })],
    )
    expect(plan.raises).toEqual([expect.objectContaining({
      branchId: 800,
      currentCents: 6_499_500,
      amountAllocatedCents: 6_500_000,
      source: "REMAINING_PLUS_USED",
    })])
  })

  it("creates the row at what is left when nothing is used yet and legacy has no monthly figure", () => {
    const plan = planBranchBudgets([location({ ID: 80, MonthlyBudget: 0, TotalBudget: 30000 })], pins(80), [])
    expect(plan.creates).toEqual([expect.objectContaining({ branchId: 800, amountAllocatedCents: 3_000_000 })])
  })

  it("counts a credit as already covering part of the used amount", () => {
    const plan = planBranchBudgets(
      [location({ ID: 80, MonthlyBudget: 0, TotalBudget: 100 })],
      pins(80),
      [current({ branchId: 800, amountAllocatedCents: 50_000, amountCreditedCents: 20_000, amountSpentCents: 70_000 })],
    )
    // remaining 100.00 + (70,000 - 20,000 credited) used = 60,000 allocated
    expect(plan.raises[0].amountAllocatedCents).toBe(60_000)
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
    const plan = planBranchBudgets(
      [location({ ID: 2, MonthlyBudget: 1000 })],
      pins(2),
      [current({ branchId: 20, amountAllocatedCents: 100_000 })],
    )
    expect(plan.creates).toHaveLength(0)
    expect(plan.raises).toHaveLength(0)
    expect(plan.drift).toHaveLength(0)
    expect(plan.unchanged).toBe(1)
  })

  it("raises an allocation below the legacy monthly budget", () => {
    const plan = planBranchBudgets(
      [location({ ID: 2, MonthlyBudget: 1000 })],
      pins(2),
      [current({ branchId: 20, amountAllocatedCents: 0 })],
    )
    expect(plan.raises).toEqual([{
      branchId: 20,
      branchName: "Branch 2",
      legacyLocationId: 2,
      period: "2026-09",
      currentCents: 0,
      amountAllocatedCents: 100_000,
      source: "MONTHLY_BUDGET",
    }])
    expect(plan.lowers).toHaveLength(0)
    expect(plan.drift).toHaveLength(0)
  })

  // Lowering takes away budget a Head Office user may have granted in
  // OneFlowe, so it is reported unless the caller asks for it.
  it("reports an allocation above legacy as drift unless lowering is requested", () => {
    const plan = planBranchBudgets(
      [location({ ID: 2, MonthlyBudget: 1000 })],
      pins(2),
      [current({ branchId: 20, amountAllocatedCents: 500_000 })],
    )
    expect(plan.lowers).toHaveLength(0)
    expect(plan.drift).toEqual([{
      branchId: 20,
      branchName: "Branch 2",
      period: "2026-09",
      currentCents: 500_000,
      legacyCents: 100_000,
      reason: "LOWER_NOT_REQUESTED",
    }])
  })

  it("lowers an allocation to legacy when asked and the invariant still holds", () => {
    const plan = planBranchBudgets(
      [location({ ID: 2, MonthlyBudget: 1000 })],
      pins(2),
      [current({ branchId: 20, amountAllocatedCents: 500_000, amountSpentCents: 90_000 })],
      { allowLower: true },
    )
    expect(plan.lowers).toEqual([expect.objectContaining({ currentCents: 500_000, amountAllocatedCents: 100_000 })])
    expect(plan.drift).toHaveLength(0)
  })

  // budgets_values_valid_ck requires allocated + credited to cover spent + held.
  it("refuses to lower below what is already spent or held, even when asked", () => {
    const plan = planBranchBudgets(
      [location({ ID: 2, MonthlyBudget: 1000 })],
      pins(2),
      [current({ branchId: 20, amountAllocatedCents: 500_000, amountSpentCents: 100_000, amountHeldCents: 1 })],
      { allowLower: true },
    )
    expect(plan.lowers).toHaveLength(0)
    expect(plan.drift[0].reason).toBe("LOWER_WOULD_BREAK_INVARIANT")
  })

  it("is idempotent: planning against its own result creates nothing", () => {
    const locations = [location({ ID: 2, MonthlyBudget: 1000 }), location({ ID: 3, MonthlyBudget: 2000 })]
    const first = planBranchBudgets(locations, pins(2, 3), [])
    expect(first.creates).toHaveLength(2)

    const applied: CurrentBudget[] = first.creates.map((entry) => current({
      branchId: entry.branchId,
      period: entry.period,
      amountAllocatedCents: entry.amountAllocatedCents,
    }))
    const second = planBranchBudgets(locations, pins(2, 3), applied)

    expect(second.creates).toHaveLength(0)
    expect(second.raises).toHaveLength(0)
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

describe("planZeroBudgets", () => {
  const branch = (branchId: number, baselineBudgetCents = 0): BudgetBranch =>
    ({ branchId, name: `Branch ${branchId}`, baselineBudgetCents })

  it("creates a zero row for a branch that has none this period", () => {
    const plan = planZeroBudgets("2026-09", [branch(1)], [])
    expect(plan.creates).toEqual([expect.objectContaining({ branchId: 1, period: "2026-09", amountAllocatedCents: 0 })])
    expect(plan.lowers).toHaveLength(0)
  })

  it("lowers an unused allocation to zero", () => {
    const plan = planZeroBudgets("2026-09", [branch(1)], [current({ branchId: 1, amountAllocatedCents: 3_500_000 })])
    expect(plan.lowers).toEqual([expect.objectContaining({
      branchId: 1, currentCents: 3_500_000, amountAllocatedCents: 0, source: "ZERO_PERIOD",
    })])
  })

  // budgets_values_valid_ck: allocated + credited >= spent + held. What is
  // already spent or held stays covered; only the remainder is removed.
  it("lowers a used allocation to exactly what is spent and held, net of credit", () => {
    const plan = planZeroBudgets("2026-09", [branch(1)], [
      current({ branchId: 1, amountAllocatedCents: 90_000_000, amountSpentCents: 80_000_000, amountHeldCents: 5_000_000, amountCreditedCents: 1_000_000 }),
    ])
    expect(plan.lowers[0].amountAllocatedCents).toBe(84_000_000)
  })

  it("counts a row already at its floor as unchanged", () => {
    const plan = planZeroBudgets("2026-09", [branch(1), branch(2)], [
      current({ branchId: 1, amountAllocatedCents: 6_499_500, amountSpentCents: 6_499_500 }),
      current({ branchId: 2, amountAllocatedCents: 0 }),
    ])
    expect(plan.unchanged).toBe(2)
    expect(plan.lowers).toHaveLength(0)
    expect(plan.creates).toHaveLength(0)
  })

  it("touches only the requested period", () => {
    const plan = planZeroBudgets("2026-09", [branch(1)], [current({ branchId: 1, period: "2026-08", amountAllocatedCents: 100 })])
    expect(plan.creates).toHaveLength(1)
    expect(plan.lowers).toHaveLength(0)
  })

  // The budgets API re-creates a missing month at the baseline and resets a
  // zero row with no spend back to it, so a zero only holds with the baseline
  // cleared too.
  it("clears a non-zero baseline so the zero survives the budgets API", () => {
    const plan = planZeroBudgets("2026-09", [branch(1, 2_000_000), branch(2, 0)], [])
    expect(plan.baselineResets).toEqual([{ branchId: 1, branchName: "Branch 1", currentCents: 2_000_000 }])
  })

  it("refuses a malformed period", () => {
    expect(() => planZeroBudgets("2026-9", [], [])).toThrow(/period/)
    expect(() => planZeroBudgets("2026-13", [], [])).toThrow(/period/)
  })

  it("is idempotent: planning against its own result changes nothing", () => {
    const branches = [branch(1, 500), branch(2)]
    const first = planZeroBudgets("2026-09", branches, [current({ branchId: 2, amountAllocatedCents: 700, amountHeldCents: 200 })])
    expect(first.creates).toHaveLength(1)
    expect(first.lowers).toHaveLength(1)
    expect(first.baselineResets).toHaveLength(1)

    const applied: CurrentBudget[] = [
      current({ branchId: 1, amountAllocatedCents: 0 }),
      current({ branchId: 2, amountAllocatedCents: 200, amountHeldCents: 200 }),
    ]
    const second = planZeroBudgets("2026-09", [branch(1, 0), branch(2)], applied)
    expect(second.creates).toHaveLength(0)
    expect(second.lowers).toHaveLength(0)
    expect(second.baselineResets).toHaveLength(0)
    expect(second.unchanged).toBe(2)
  })
})

describe("summarizeBudgets", () => {
  it("totals the net change in allocation", () => {
    const plan = planBranchBudgets(
      [
        location({ ID: 2, MonthlyBudget: 900000 }),
        location({ ID: 3, MonthlyBudget: 21000 }),
        location({ ID: 4, MonthlyBudget: 0 }),
        location({ ID: 5, MonthlyBudget: 100 }),
        location({ ID: 6, MonthlyBudget: 100 }),
      ],
      pins(2, 3, 4, 5, 6),
      [
        current({ branchId: 50, amountAllocatedCents: 4_000 }),
        current({ branchId: 60, amountAllocatedCents: 12_000 }),
      ],
      { allowLower: true },
    )
    expect(summarizeBudgets(plan)).toEqual({
      fundedLocations: 4,
      toCreate: 2,
      toRaise: 1,
      toLower: 1,
      baselineResets: 0,
      unchanged: 0,
      drift: 0,
      skipped: 1,
      totalAllocatedCents: 92_100_000 + 6_000 - 2_000,
      periods: ["2026-09"],
    })
  })
})
