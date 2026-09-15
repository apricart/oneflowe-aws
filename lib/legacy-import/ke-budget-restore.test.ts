import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

import type { CurrentBudget } from "./ke-budgets"
import {
  parseZeroRunReport,
  planBudgetRestore,
  restorePlanLines,
  summarizeRestore,
  type RestoreBranch,
  type ZeroRunReport,
} from "./ke-budget-restore"

const PERIOD = "2026-09"

/** A committed zero-run report as `sync-ke.ts` writes it, trimmed to what the restore reads. */
function report(overrides: Partial<{
  mode: string
  budgetMode: string
  zeroPeriod: string
  planDigest: string
  lowers: ZeroRunReport["budgets"]["lowers"]
  baselineResets: ZeroRunReport["budgets"]["baselineResets"]
  creates: ZeroRunReport["budgets"]["creates"]
}> = {}): unknown {
  return {
    generatedAt: "2026-09-13T23:31:38.518Z",
    mode: overrides.mode ?? "COMMIT",
    organization: { id: 10, code: "0001", name: "K-Electric" },
    planDigest: overrides.planDigest ?? "abc123",
    options: {
      stockLevel: 500,
      resetStock: true,
      budgetMode: overrides.budgetMode ?? "zero",
      zeroPeriod: overrides.zeroPeriod ?? PERIOD,
      lowerBudgets: false,
    },
    counts: { irrelevant: 1 },
    budgets: {
      creates: overrides.creates ?? [],
      raises: [],
      lowers: overrides.lowers ?? [],
      baselineResets: overrides.baselineResets ?? [],
      drift: [],
      skipped: [],
      unchanged: 18,
    },
    branchCatalogue: { ignored: true },
  }
}

const lowered = (branchId: number, from: number, to: number) => ({
  branchId,
  branchName: `Branch ${branchId}`,
  legacyLocationId: 0,
  period: PERIOD,
  currentCents: from,
  amountAllocatedCents: to,
  source: "ZERO_PERIOD" as const,
})

const cleared = (branchId: number, from: number) => ({
  branchId,
  branchName: `Branch ${branchId}`,
  currentCents: from,
})

const created = (branchId: number) => ({
  branchId,
  branchName: `Branch ${branchId}`,
  legacyLocationId: 0,
  period: PERIOD,
  amountAllocatedCents: 0,
})

function row(overrides: Partial<CurrentBudget> & { branchId: number; amountAllocatedCents: number }): CurrentBudget {
  return { period: PERIOD, amountCreditedCents: 0, amountSpentCents: 0, amountHeldCents: 0, ...overrides }
}

function branch(overrides: Partial<RestoreBranch> & { branchId: number }): RestoreBranch {
  return { name: `Branch ${overrides.branchId}`, status: "active", baselineBudgetCents: 0, ...overrides }
}

const parsed = (value: unknown = report()) => parseZeroRunReport(value)

describe("parseZeroRunReport", () => {
  it("accepts a committed zero-run report and keeps only what the restore needs", () => {
    const result = parsed(report({ lowers: [lowered(133, 90_000_000, 89_999_400)], baselineResets: [cleared(133, 90_000_000)] }))
    expect(result.organization).toEqual({ id: 10, code: "0001", name: "K-Electric" })
    expect(result.options.zeroPeriod).toBe(PERIOD)
    expect(result.budgets.lowers).toHaveLength(1)
    expect(result.budgets.baselineResets).toHaveLength(1)
    expect((result as Record<string, unknown>).branchCatalogue).toBeUndefined()
  })

  it("refuses a dry-run report — only a committed run has anything to reverse", () => {
    expect(() => parsed(report({ mode: "DRY_RUN" }))).toThrow(/committed run/)
  })

  it("refuses a report from a legacy-mode run", () => {
    expect(() => parsed(report({ budgetMode: "legacy" }))).toThrow(/--budgets=zero/)
  })

  it("refuses an unreadable period", () => {
    expect(() => parsed(report({ zeroPeriod: "2026-13" }))).toThrow(/YYYY-MM/)
    expect(() => parsed(report({ zeroPeriod: "September" }))).toThrow(/YYYY-MM/)
  })

  it("refuses an entry for a period other than the one zeroed", () => {
    expect(() => parsed(report({ lowers: [{ ...lowered(133, 100, 0), period: "2026-08" }] })))
      .toThrow(/2026-08, not the zeroed period 2026-09/)
  })

  it("refuses negative or fractional money", () => {
    expect(() => parsed(report({ lowers: [lowered(133, -1, 0)] }))).toThrow()
    expect(() => parsed(report({ baselineResets: [cleared(133, 12.5)] }))).toThrow()
  })

  it("refuses something that is not a report at all", () => {
    expect(() => parsed(null)).toThrow(/Not a committed zero-budget report/)
    expect(() => parsed({ budgets: {} })).toThrow(/Not a committed zero-budget report/)
  })
})

describe("planBudgetRestore — allocations", () => {
  it("puts a lowered allocation back when the row still holds the zeroed value", () => {
    const plan = planBudgetRestore(
      parsed(report({ lowers: [lowered(133, 90_000_000, 89_999_400)] })),
      [row({ branchId: 133, amountAllocatedCents: 89_999_400, amountSpentCents: 89_999_400 })],
      [branch({ branchId: 133 })],
    )
    expect(plan.allocationRestores).toEqual([{
      branchId: 133,
      branchName: "Branch 133",
      period: PERIOD,
      currentCents: 89_999_400,
      amountAllocatedCents: 90_000_000,
    }])
    expect(plan.skipped).toEqual([])
    expect(plan.unchanged.allocations).toBe(0)
  })

  it("counts a row already back at its before-value as unchanged, so a second run is a no-op", () => {
    const plan = planBudgetRestore(
      parsed(report({ lowers: [lowered(133, 90_000_000, 89_999_400)] })),
      [row({ branchId: 133, amountAllocatedCents: 90_000_000, amountSpentCents: 89_999_400 })],
      [branch({ branchId: 133 })],
    )
    expect(plan.allocationRestores).toEqual([])
    expect(plan.unchanged.allocations).toBe(1)
  })

  it("leaves a row that has moved since the zero run alone and says so", () => {
    const plan = planBudgetRestore(
      parsed(report({ lowers: [lowered(133, 90_000_000, 89_999_400)] })),
      [row({ branchId: 133, amountAllocatedCents: 95_000_000, amountSpentCents: 89_999_400 })],
      [branch({ branchId: 133 })],
    )
    expect(plan.allocationRestores).toEqual([])
    expect(plan.skipped).toEqual([expect.objectContaining({
      kind: "ALLOCATION",
      branchId: 133,
      reason: "ALLOCATION_MOVED",
      detail: expect.stringContaining("95000000"),
    })])
  })

  it("reports a row that no longer exists rather than creating one", () => {
    const plan = planBudgetRestore(
      parsed(report({ lowers: [lowered(133, 90_000_000, 0)] })),
      [],
      [branch({ branchId: 133 })],
    )
    expect(plan.allocationRestores).toEqual([])
    expect(plan.skipped).toEqual([expect.objectContaining({ kind: "ALLOCATION", branchId: 133, reason: "ROW_MISSING" })])
  })

  it("consults only the zeroed period, however many the organization holds", () => {
    const plan = planBudgetRestore(
      parsed(report({ lowers: [lowered(133, 100, 0)] })),
      [
        row({ branchId: 133, period: "2026-08", amountAllocatedCents: 0 }),
        row({ branchId: 133, period: PERIOD, amountAllocatedCents: 0 }),
        row({ branchId: 133, period: "2026-10", amountAllocatedCents: 0 }),
      ],
      [branch({ branchId: 133 })],
    )
    expect(plan.allocationRestores).toHaveLength(1)
    expect(plan.allocationRestores[0].period).toBe(PERIOD)
  })

  it("never touches the rows the zero run created at 0 — a 0 row is what the shop creates on demand", () => {
    const plan = planBudgetRestore(
      parsed(report({ creates: [created(181), created(182)] })),
      [row({ branchId: 181, amountAllocatedCents: 0 }), row({ branchId: 182, amountAllocatedCents: 0 })],
      [branch({ branchId: 181 }), branch({ branchId: 182 })],
    )
    expect(plan.allocationRestores).toEqual([])
    expect(plan.baselineRestores).toEqual([])
    expect(plan.createdAtZero).toBe(2)
  })
})

describe("planBudgetRestore — baselines", () => {
  it("puts a cleared baseline back when it is still 0", () => {
    const plan = planBudgetRestore(
      parsed(report({ baselineResets: [cleared(133, 90_000_000)] })),
      [row({ branchId: 133, amountAllocatedCents: 89_999_400, amountSpentCents: 89_999_400 })],
      [branch({ branchId: 133, baselineBudgetCents: 0 })],
    )
    expect(plan.baselineRestores).toEqual([{
      branchId: 133,
      branchName: "Branch 133",
      baselineBudgetCents: 90_000_000,
      refundsOnNextLoad: false,
    }])
  })

  it("counts a baseline already back as unchanged", () => {
    const plan = planBudgetRestore(
      parsed(report({ baselineResets: [cleared(133, 90_000_000)] })),
      [],
      [branch({ branchId: 133, baselineBudgetCents: 90_000_000 })],
    )
    expect(plan.baselineRestores).toEqual([])
    expect(plan.unchanged.baselines).toBe(1)
  })

  it("leaves a baseline someone has set since alone", () => {
    const plan = planBudgetRestore(
      parsed(report({ baselineResets: [cleared(133, 90_000_000)] })),
      [],
      [branch({ branchId: 133, baselineBudgetCents: 50_000 })],
    )
    expect(plan.baselineRestores).toEqual([])
    expect(plan.skipped).toEqual([expect.objectContaining({ kind: "BASELINE", branchId: 133, reason: "BASELINE_MOVED" })])
  })

  it("reports a branch that is not in the organization", () => {
    const plan = planBudgetRestore(
      parsed(report({ baselineResets: [cleared(999, 1_000)] })),
      [],
      [branch({ branchId: 133 })],
    )
    expect(plan.baselineRestores).toEqual([])
    expect(plan.skipped).toEqual([expect.objectContaining({ kind: "BASELINE", branchId: 999, reason: "BRANCH_MISSING" })])
  })

  it("restores the baseline of an inactive branch too — the zero run cleared it, and it is harmless", () => {
    const plan = planBudgetRestore(
      parsed(report({ baselineResets: [cleared(133, 1_000)] })),
      [],
      [branch({ branchId: 133, status: "inactive" })],
    )
    expect(plan.baselineRestores).toHaveLength(1)
  })

  // `syncCurrentMoneyBudgets` resets a 0 row with no spend or credit to the
  // baseline on the next page load. That is what would have happened before
  // the zero run as well, but the operator should hear it from the plan.
  it("flags a baseline whose month row will be re-funded by the budgets page on its next load", () => {
    const plan = planBudgetRestore(
      parsed(report({ baselineResets: [cleared(150, 2_000_000), cleared(133, 90_000_000), cleared(160, 5_000)] })),
      [
        row({ branchId: 150, amountAllocatedCents: 0 }),
        row({ branchId: 133, amountAllocatedCents: 89_999_400, amountSpentCents: 89_999_400 }),
        row({ branchId: 160, amountAllocatedCents: 0, amountCreditedCents: 100 }),
      ],
      [branch({ branchId: 150 }), branch({ branchId: 133 }), branch({ branchId: 160 })],
    )
    const byBranch = new Map(plan.baselineRestores.map((entry) => [entry.branchId, entry.refundsOnNextLoad]))
    expect(byBranch.get(150)).toBe(true)
    expect(byBranch.get(133)).toBe(false)
    expect(byBranch.get(160)).toBe(false)
  })

  it("does not flag a re-fund when the same run restores the row's allocation", () => {
    const plan = planBudgetRestore(
      parsed(report({ lowers: [lowered(133, 3_000_000, 0)], baselineResets: [cleared(133, 3_000_000)] })),
      [row({ branchId: 133, amountAllocatedCents: 0 })],
      [branch({ branchId: 133 })],
    )
    expect(plan.allocationRestores).toHaveLength(1)
    expect(plan.baselineRestores[0].refundsOnNextLoad).toBe(false)
  })

  it("does not flag a re-fund for a branch with no month row at all", () => {
    const plan = planBudgetRestore(
      parsed(report({ baselineResets: [cleared(133, 3_000_000)] })),
      [],
      [branch({ branchId: 133 })],
    )
    expect(plan.baselineRestores[0].refundsOnNextLoad).toBe(false)
  })
})

describe("planBudgetRestore — the production shape", () => {
  // KE HOUSE: allocation and baseline both restored. HR L&OD: allocation and
  // baseline differ from each other and each goes back to its own value.
  // Project Dept: allocation only, no baseline. GSMP West: baseline only, row
  // already at its floor. HOPE: created at 0, left alone.
  const production = () => parsed(report({
    lowers: [
      lowered(133, 90_000_000, 89_999_400),
      lowered(168, 5_519_100, 0),
      lowered(178, 15_500_000, 15_436_500),
    ],
    baselineResets: [cleared(133, 90_000_000), cleared(168, 5_546_600), cleared(150, 2_000_000)],
    creates: [created(181)],
  }))
  const rows = () => [
    row({ branchId: 133, amountAllocatedCents: 89_999_400, amountSpentCents: 89_999_400 }),
    row({ branchId: 168, amountAllocatedCents: 0 }),
    row({ branchId: 178, amountAllocatedCents: 15_436_500, amountSpentCents: 15_436_500 }),
    row({ branchId: 150, amountAllocatedCents: 0 }),
    row({ branchId: 181, amountAllocatedCents: 0 }),
  ]
  const tree = () => [133, 168, 178, 150, 181].map((id) => branch({ branchId: id }))

  it("plans every write and nothing else", () => {
    const plan = planBudgetRestore(production(), rows(), tree())
    expect(plan.allocationRestores.map((entry) => [entry.branchId, entry.amountAllocatedCents]))
      .toEqual([[133, 90_000_000], [168, 5_519_100], [178, 15_500_000]])
    expect(plan.baselineRestores.map((entry) => [entry.branchId, entry.baselineBudgetCents, entry.refundsOnNextLoad]))
      .toEqual([[133, 90_000_000, false], [168, 5_546_600, false], [150, 2_000_000, true]])
    expect(plan.skipped).toEqual([])
    expect(plan.createdAtZero).toBe(1)
    expect(summarizeRestore(plan)).toEqual({
      period: PERIOD,
      allocationsToRestore: 3,
      baselinesToRestore: 3,
      refundOnNextLoad: 1,
      unchangedAllocations: 0,
      unchangedBaselines: 0,
      skipped: 0,
      createdAtZeroLeftAlone: 1,
      totalRestoredCents: 600 + 5_519_100 + 63_500,
    })
  })

  it("is idempotent against its own result", () => {
    const first = planBudgetRestore(production(), rows(), tree())
    const restoredRows = rows().map((entry) => {
      const restore = first.allocationRestores.find((candidate) => candidate.branchId === entry.branchId)
      return restore ? { ...entry, amountAllocatedCents: restore.amountAllocatedCents } : entry
    })
    const restoredTree = tree().map((entry) => {
      const restore = first.baselineRestores.find((candidate) => candidate.branchId === entry.branchId)
      return restore ? { ...entry, baselineBudgetCents: restore.baselineBudgetCents } : entry
    })
    const second = planBudgetRestore(production(), restoredRows, restoredTree)
    expect(second.allocationRestores).toEqual([])
    expect(second.baselineRestores).toEqual([])
    expect(second.skipped).toEqual([])
    expect(second.unchanged).toEqual({ allocations: 3, baselines: 3 })
  })
})

describe("restorePlanLines", () => {
  const digest = (lines: string[]) => createHash("sha256").update(lines.join("\n")).digest("hex")

  it("lists every write in a fixed order under the source report's digest", () => {
    const plan = planBudgetRestore(
      parsed(report({ lowers: [lowered(178, 200, 0), lowered(133, 100, 0)], baselineResets: [cleared(133, 100)] })),
      [row({ branchId: 133, amountAllocatedCents: 0 }), row({ branchId: 178, amountAllocatedCents: 0 })],
      [branch({ branchId: 133 }), branch({ branchId: 178 })],
    )
    expect(restorePlanLines(plan)).toEqual([
      "SOURCE abc123",
      `PERIOD ${PERIOD}`,
      `ALLOC 133 ${PERIOD} 0 -> 100`,
      `ALLOC 178 ${PERIOD} 0 -> 200`,
      "BASELINE 133 0 -> 100",
    ])
  })

  it("differs between two reports that plan the same writes, so a digest cannot be reused across runs", () => {
    const rows = [row({ branchId: 133, amountAllocatedCents: 0 })]
    const tree = [branch({ branchId: 133 })]
    const a = planBudgetRestore(parsed(report({ planDigest: "run-a", lowers: [lowered(133, 100, 0)] })), rows, tree)
    const b = planBudgetRestore(parsed(report({ planDigest: "run-b", lowers: [lowered(133, 100, 0)] })), rows, tree)
    expect(digest(restorePlanLines(a))).not.toBe(digest(restorePlanLines(b)))
  })

  it("differs when a row has moved, so the commit refuses a stale digest", () => {
    const source = parsed(report({ lowers: [lowered(133, 100, 0)] }))
    const tree = [branch({ branchId: 133 })]
    const before = planBudgetRestore(source, [row({ branchId: 133, amountAllocatedCents: 0 })], tree)
    const moved = planBudgetRestore(source, [row({ branchId: 133, amountAllocatedCents: 50 })], tree)
    expect(digest(restorePlanLines(before))).not.toBe(digest(restorePlanLines(moved)))
  })
})
