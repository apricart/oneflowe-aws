import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  buildCarryForwardPlan,
  carryForwardPlanLines,
  resolveCarryForwardCents,
  skipReasonFor,
  type CarryForwardCandidate,
} from "./ke-budget-carryforward-rules"

const PERIOD = "2026-08"
const repoFile = (relative: string) =>
  readFileSync(path.resolve(__dirname, "../..", relative), "utf8")

const candidate = (overrides: Partial<CarryForwardCandidate> = {}): CarryForwardCandidate => ({
  branchId: 178,
  branchName: "Project Dept",
  branchCode: null,
  baselineBudgetCents: 0,
  currentBudgetId: 900,
  currentAllocatedCents: 0,
  currentSpentCents: 0,
  currentHeldCents: 0,
  currentCreditedCents: 0,
  sourcePeriod: "2026-07",
  sourceAllocatedCents: 15_500_000,
  preBackfillAllocatedCents: null,
  ...overrides,
})

describe("carry-forward eligibility", () => {
  it("restores a branch that was funded before but sits at zero now", () => {
    expect(skipReasonFor(candidate())).toBeNull()
  })

  it("leaves an already funded branch alone", () => {
    expect(skipReasonFor(candidate({ baselineBudgetCents: 3_500_000 })))
      .toBe("baseline-already-funded")
  })

  it("leaves a branch that never held an allocation alone", () => {
    expect(skipReasonFor(candidate({ sourcePeriod: null, sourceAllocatedCents: null })))
      .toBe("no-prior-funded-period")
  })

  it("never overwrites an allocation that already exists for the current period", () => {
    expect(skipReasonFor(candidate({ currentAllocatedCents: 1 })))
      .toBe("current-period-already-allocated")
  })

  it.each([
    ["spend", { currentSpentCents: 1 }],
    ["a hold", { currentHeldCents: 1 }],
    ["a credit", { currentCreditedCents: 1 }],
  ])("never touches a current-period row carrying %s", (_label, overrides) => {
    expect(skipReasonFor(candidate(overrides))).toBe("current-period-has-activity")
  })
})

describe("carry-forward amount", () => {
  it("repeats the last funded allocation unchanged", () => {
    expect(resolveCarryForwardCents(15_500_000, null))
      .toEqual({ carryForwardCents: 15_500_000, reconciliationAdjusted: false })
  })

  it("uses the pre-change allocation when the spend backfill had raised the source row", () => {
    // NCSD 2026-06 was raised from Rs 43,000 to Rs 54,295 to cover recorded spend.
    expect(resolveCarryForwardCents(5_429_500, 4_300_000))
      .toEqual({ carryForwardCents: 4_300_000, reconciliationAdjusted: true })
  })

  it("keeps the stored allocation when the snapshot matches or is higher", () => {
    expect(resolveCarryForwardCents(4_300_000, 4_300_000).carryForwardCents).toBe(4_300_000)
    expect(resolveCarryForwardCents(4_300_000, 9_000_000).carryForwardCents).toBe(4_300_000)
    expect(resolveCarryForwardCents(4_300_000, 0).carryForwardCents).toBe(4_300_000)
  })
})

describe("plan construction", () => {
  it("separates restored branches from skipped ones and never invents an amount", () => {
    const plan = buildCarryForwardPlan([
      candidate(),
      candidate({ branchId: 234, branchName: "REGIONAL HEAD", sourcePeriod: null, sourceAllocatedCents: null }),
      candidate({ branchId: 133, branchName: "KE HOUSE", baselineBudgetCents: 90_000_000 }),
    ], PERIOD)

    expect(plan.rows).toHaveLength(1)
    expect(plan.rows[0]).toMatchObject({
      branchId: 178,
      operation: "update",
      carryForwardCents: 15_500_000,
      sourcePeriod: "2026-07",
    })
    expect(plan.skipped.map((row) => row.reason))
      .toEqual(["no-prior-funded-period", "baseline-already-funded"])
  })

  it("inserts rather than updates when the current period row does not exist yet", () => {
    const plan = buildCarryForwardPlan([candidate({ currentBudgetId: null })], PERIOD)
    expect(plan.rows[0].operation).toBe("insert")
  })

  it("rejects a source period that is not strictly before the current period", () => {
    expect(() => buildCarryForwardPlan([candidate({ sourcePeriod: PERIOD })], PERIOD))
      .toThrow(/not before/)
  })

  it("produces an order-independent digest so a preflight pins its commit", () => {
    const rows = [candidate(), candidate({ branchId: 242, branchName: "REGION 2" })]
    const forward = carryForwardPlanLines(buildCarryForwardPlan(rows, PERIOD).rows)
    const reversed = carryForwardPlanLines(buildCarryForwardPlan([...rows].reverse(), PERIOD).rows)
    expect(forward).toEqual(reversed)
  })
})

describe("script scoping (source-pinned)", () => {
  const script = repoFile("scripts/restore-ke-branch-budget-carryforward.ts")

  it("targets only the K-Electric organization", () => {
    expect(script).toContain('const KE = { id: 10, code: "0001", name: "K-Electric" } as const')
    expect(script).toContain("b.organization_id = $1")
    expect(script).toContain("and b.status = 'active'")
  })

  it("scopes every write to that organization and to the current period", () => {
    expect(script).toContain("where id = $2 and organization_id = $3 and coalesce(baseline_budget_cents, 0) = $4")
    expect(script).toContain("and organization_id = $3")
    expect(script).toContain("and period = $5")
  })

  it("refuses to overwrite a current-period row that carries any value", () => {
    expect(script).toContain("and amount_allocated_cents = 0")
    expect(script).toContain("and amount_spent_cents = 0")
    expect(script).toContain("and amount_held_cents = 0")
    expect(script).toContain("and amount_credited_cents = 0")
  })

  it("verifies no other tenant and no historical period moved", () => {
    expect(script).toContain("where organization_id <> $1")
    expect(script).toContain("where organization_id = $1 and period <> $2")
    expect(script).toContain("Other tenants' budgets changed; investigate immediately")
    expect(script).toContain("K-Electric budget history changed; investigate immediately")
  })

  it("requires an explicit confirmation triple before writing", () => {
    expect(script).toContain("--confirm-organization")
    expect(script).toContain("--confirm-plan-sha256")
    expect(script).toContain("--expected-updates")
  })
})

describe("monthly repeat contract (source-pinned)", () => {
  it("seeds each new period's allocation from the branch baseline on the budgets page", () => {
    const route = repoFile("app/api/v1/budgets/route.ts")
    expect(route).toContain("amountAllocatedCents: row.baselineBudgetCents || 0")
  })

  it("seeds it from the same baseline on both order creation paths", () => {
    expect(repoFile("app/api/v1/orders/route.ts"))
      .toContain("amountAllocatedCents: branch.baselineBudgetCents")
    expect(repoFile("lib/server/group-order-creation.ts"))
      .toContain("amountAllocatedCents: branch.baselineBudgetCents")
  })

  it("changes the repeating figure only when a user allocates a monthly budget", () => {
    const route = repoFile("app/api/v1/budgets/route.ts")
    expect(route).toContain(".set({ baselineBudgetCents: newAllocated, updatedAt: new Date() })")
    // Who may allocate is decided in one shared module, not inline here: the
    // two tenant-wide roles, and the approver over its assigned branches.
    expect(route).toContain('from "@/lib/money-budget-access"')
    expect(route).toContain("if (!canManageMoneyBudgets(role)) {")
    expect(repoFile("lib/money-budget-access.ts"))
      .toContain('export const MONEY_BUDGET_MANAGER_ROLES = ["SUPER_ADMIN", "HEAD_OFFICE", "GROUP_USER"] as const')
  })
})
