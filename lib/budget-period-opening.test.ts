import { describe, expect, it } from "vitest"

import { budgetRowsToOpen, openableBudgetPeriod } from "@/lib/budget-period-opening"

describe("openableBudgetPeriod", () => {
  const midOctober = new Date("2026-10-15T08:00:00.000Z")

  it("is the engine's month when the read covers it", () => {
    expect(openableBudgetPeriod(midOctober, ["2026-09", "2026-10"])).toBe("2026-10")
  })

  it("is nothing for a read of past months only", () => {
    expect(openableBudgetPeriod(midOctober, ["2026-08", "2026-09"])).toBeNull()
  })

  it("is nothing for an empty read", () => {
    expect(openableBudgetPeriod(midOctober, [])).toBeNull()
  })

  it("does not open the Karachi month while it is still ahead of the engine", () => {
    // 00:30 on 1 November in Karachi; the engine still holds against October.
    const karachiFirst = new Date("2026-10-31T19:30:00.000Z")
    expect(openableBudgetPeriod(karachiFirst, ["2026-11"])).toBeNull()
    expect(openableBudgetPeriod(karachiFirst, ["2026-10", "2026-11"])).toBe("2026-10")
  })

  it("follows the engine across the UTC boundary", () => {
    expect(openableBudgetPeriod(new Date("2026-11-01T00:00:00.000Z"), ["2026-10", "2026-11"])).toBe("2026-11")
    expect(openableBudgetPeriod(new Date("2026-10-31T23:59:59.999Z"), ["2026-10", "2026-11"])).toBe("2026-10")
  })
})

describe("budgetRowsToOpen", () => {
  const period = "2026-10"

  it("opens a branch with no row at its baseline and nothing spent, held or credited", () => {
    expect(budgetRowsToOpen({
      period,
      candidates: [{ branchId: 7, organizationId: 10, baselineBudgetCents: 2_100_000 }],
      existingBranchIds: [],
    })).toEqual([{
      organizationId: 10,
      branchId: 7,
      period,
      amountAllocatedCents: 2_100_000,
      amountSpentCents: 0,
      amountHeldCents: 0,
      amountCreditedCents: 0,
    }])
  })

  it("never touches a branch that already has a row, whatever it holds", () => {
    expect(budgetRowsToOpen({
      period,
      candidates: [{ branchId: 7, organizationId: 10, baselineBudgetCents: 5_000 }],
      existingBranchIds: new Set([7]),
    })).toEqual([])
  })

  it.each([
    ["zero", 0],
    ["null", null],
    ["negative", -1],
    ["fractional", 10.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 2],
  ])("leaves a branch whose baseline is %s without a row", (_label, baseline) => {
    expect(budgetRowsToOpen({
      period,
      candidates: [{ branchId: 7, organizationId: 10, baselineBudgetCents: baseline as number | null }],
      existingBranchIds: [],
    })).toEqual([])
  })

  it("never opens a row for a branch without a tenant", () => {
    expect(budgetRowsToOpen({
      period,
      candidates: [{ branchId: 7, organizationId: null, baselineBudgetCents: 5_000 }],
      existingBranchIds: [],
    })).toEqual([])
  })

  it("never opens a row for an invalid branch id", () => {
    expect(budgetRowsToOpen({
      period,
      candidates: [
        { branchId: 0, organizationId: 10, baselineBudgetCents: 5_000 },
        { branchId: -3, organizationId: 10, baselineBudgetCents: 5_000 },
      ],
      existingBranchIds: [],
    })).toEqual([])
  })

  it("opens a branch listed twice once", () => {
    const rows = budgetRowsToOpen({
      period,
      candidates: [
        { branchId: 7, organizationId: 10, baselineBudgetCents: 5_000 },
        { branchId: 7, organizationId: 10, baselineBudgetCents: 5_000 },
      ],
      existingBranchIds: [],
    })
    expect(rows.map((row) => row.branchId)).toEqual([7])
  })

  it("keeps each branch's own tenant and baseline in a mixed list", () => {
    const rows = budgetRowsToOpen({
      period,
      candidates: [
        { branchId: 1, organizationId: 10, baselineBudgetCents: 1_000 },
        { branchId: 2, organizationId: 11, baselineBudgetCents: 0 },
        { branchId: 3, organizationId: 11, baselineBudgetCents: 3_000 },
        { branchId: 4, organizationId: 10, baselineBudgetCents: 4_000 },
      ],
      existingBranchIds: [4],
    })
    expect(rows.map(({ branchId, organizationId, amountAllocatedCents }) => ({ branchId, organizationId, amountAllocatedCents })))
      .toEqual([
        { branchId: 1, organizationId: 10, amountAllocatedCents: 1_000 },
        { branchId: 3, organizationId: 11, amountAllocatedCents: 3_000 },
      ])
  })
})
