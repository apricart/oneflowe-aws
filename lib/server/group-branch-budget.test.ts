import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import {
  budgetRemainingRatio,
  summarizeBranchBudget,
  type BranchBudgetRecord,
} from "@/lib/branch-budget-summary"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

const record = (overrides: Partial<BranchBudgetRecord> = {}): BranchBudgetRecord => ({
  amountAllocatedCents: 0,
  amountSpentCents: 0,
  amountHeldCents: 0,
  amountCreditedCents: 0,
  ...overrides,
})

const summarize = (
  budget: BranchBudgetRecord | null,
  baselineBudgetCents: number | null = 0,
) => summarizeBranchBudget({ branchId: 7, period: "2026-08", baselineBudgetCents, budget })

describe("branch budget summary", () => {
  it("derives remaining the same way the ordering engine derives available", () => {
    // lib/server/group-order-creation.ts:
    //   allocated + credited - spent - held
    const summary = summarize(record({
      amountAllocatedCents: 500_000,
      amountCreditedCents: 100_000,
      amountSpentCents: 150_000,
      amountHeldCents: 50_000,
    }))

    expect(summary).toMatchObject({
      branchId: 7,
      period: "2026-08",
      configured: true,
      totalCents: 600_000,
      spentCents: 150_000,
      heldCents: 50_000,
      remainingCents: 400_000,
    })
  })

  it("counts an add-on credit toward the total, not against it", () => {
    expect(summarize(record({ amountAllocatedCents: 100_000, amountCreditedCents: 25_000 })))
      .toMatchObject({ totalCents: 125_000, remainingCents: 125_000 })
  })

  it("reports the baseline for a period that has no row yet", () => {
    // The engine opens the row from the baseline on first use, so this is the
    // figure a requester will really have — not zero, and not "unconfigured".
    expect(summarize(null, 250_000)).toMatchObject({
      configured: true,
      totalCents: 250_000,
      spentCents: 0,
      heldCents: 0,
      remainingCents: 250_000,
    })
  })

  it("reports no budget only when an order would be refused for want of one", () => {
    expect(summarize(null, 0).configured).toBe(false)
    expect(summarize(null, null).configured).toBe(false)
  })

  it("calls an exhausted or zero budget configured, because it is", () => {
    // "Insufficient budget" and "no budget set up" are different messages to a
    // requester, and only the second one is head office's to fix.
    expect(summarize(record({ amountAllocatedCents: 0 })).configured).toBe(true)
    expect(summarize(record({ amountAllocatedCents: 10_000, amountSpentCents: 10_000 })))
      .toMatchObject({ configured: true, remainingCents: 0 })
  })

  it("treats missing figures as zero rather than producing NaN", () => {
    const summary = summarize({
      amountAllocatedCents: 100_000,
      amountSpentCents: null,
      amountHeldCents: null,
      amountCreditedCents: null,
    })

    expect(summary.remainingCents).toBe(100_000)
    expect(Number.isNaN(summary.remainingCents)).toBe(false)
  })

  it("holds the meter between empty and full whatever the figures say", () => {
    expect(budgetRemainingRatio(summarize(record({ amountAllocatedCents: 100_000 })))).toBe(1)
    expect(budgetRemainingRatio(summarize(record({
      amountAllocatedCents: 100_000,
      amountSpentCents: 75_000,
    })))).toBeCloseTo(0.25)
    // An over-committed budget (repair scripts show these have existed) draws
    // an empty bar rather than a negative width.
    expect(budgetRemainingRatio(summarize(record({
      amountAllocatedCents: 100_000,
      amountSpentCents: 150_000,
    })))).toBe(0)
    expect(budgetRemainingRatio(summarize(null, 0))).toBe(0)
  })
})

describe("group portal budget endpoint", () => {
  const route = source("app/api/v1/group-portal/budgets/route.ts")
  const loader = source("lib/server/group-branch-budgets.ts")

  it("admits the storefront's role alone", () => {
    // requireGroupOrderPortal gates GROUP_ORDER_PORTAL only; GROUP_USER,
    // BRANCH_ADMIN, HEAD_OFFICE and SUPER_ADMIN keep their existing budget
    // paths and gain nothing here.
    expect(route).toContain("const { actor, response } = await requireGroupOrderPortal()")
    expect(route).toContain("if (response) return response")
  })

  it("takes its branch set from the user's own assignments, never from the request", () => {
    expect(route).toContain("await loadScopedBranches(actor.scope.userId, actor.organizationId)")
    expect(route).toContain("branchIds: scopedBranches.map((branch) => branch.id)")
    expect(route).not.toContain("searchParams")
  })

  it("fails closed when the user has no assigned branches", () => {
    expect(route).toContain("if (scopedBranches.length === 0) return ok({ items: [], period })")
  })

  it("re-asserts the tenant on the read itself", () => {
    expect(loader).toContain("eq(branches.organizationId, organizationId)")
    expect(loader).toContain("eq(budgets.organizationId, organizationId)")
  })

  it("stays a read: showing a budget must never open or move a ledger row", () => {
    expect(loader).not.toMatch(/db\.(insert|update|delete|transaction)\(/)
    expect(route).not.toMatch(/db\.(insert|update|delete|transaction)\(/)
  })

  it("bills against the same period the ordering engine does", () => {
    // Not the Asia/Karachi analytics month: the figure shown has to be the one
    // the next order is checked against.
    expect(loader).toContain('return now.toISOString().slice(0, 7)')
    expect(source("lib/server/group-order-creation.ts"))
      .toContain('const period = new Date().toISOString().slice(0, 7)')
  })

  it("leaves the other roles' budget surfaces untouched", () => {
    expect(source("app/shop/page.tsx")).not.toContain("group-portal/budgets")
    expect(source("app/api/v1/budgets/route.ts")).not.toContain("group-portal")
  })
})
