import { describe, expect, it } from "vitest"

import {
  BUDGETS_DISABLED_CODE,
  DEFAULT_ORGANIZATION_BUDGETS_ENABLED,
  ORGANIZATION_BUDGETS_AUDIT_ACTION,
  budgetTrackingCoverage,
  orderTakesBudget,
} from "@/lib/organization-budget-policy"
import { organizationCreateSchema, organizationUpdateSchema } from "@/lib/server/mutation-validation"

describe("orderTakesBudget", () => {
  it("answers from the order's own flag", () => {
    expect(orderTakesBudget({ budgetTracked: true })).toBe(true)
    expect(orderTakesBudget({ budgetTracked: false })).toBe(false)
  })

  // Guessing either way corrupts a ledger: "tracked" releases another order's
  // hold on rejection, "untracked" strands a real hold forever.
  it.each([
    ["missing", {}],
    ["undefined", { budgetTracked: undefined }],
    ["null", { budgetTracked: null }],
  ])("refuses to guess when the flag is %s", (_label, order) => {
    expect(() => orderTakesBudget(order as { budgetTracked?: boolean | null })).toThrow("ORDER_BUDGET_TRACKING_UNKNOWN")
  })

  it("does not coerce a truthy non-boolean", () => {
    expect(() => orderTakesBudget({ budgetTracked: "true" as unknown as boolean })).toThrow()
    expect(() => orderTakesBudget({ budgetTracked: 1 as unknown as boolean })).toThrow()
  })
})

describe("budgetTrackingCoverage", () => {
  it("is 'all' when every tenant on screen tracks budgets, and for an empty screen", () => {
    expect(budgetTrackingCoverage([true, true])).toBe("all")
    expect(budgetTrackingCoverage([])).toBe("all")
  })

  it("is 'none' when every tenant has budgets off", () => {
    expect(budgetTrackingCoverage([false])).toBe("none")
    expect(budgetTrackingCoverage([false, false, false])).toBe("none")
  })

  it("is 'some' for a mix", () => {
    expect(budgetTrackingCoverage([true, false])).toBe("some")
  })
})

describe("the organization schemas", () => {
  const base = { name: "Acme Traders", code: "ACME" }

  it("creates a company with budget allocation off unless told otherwise", () => {
    expect(DEFAULT_ORGANIZATION_BUDGETS_ENABLED).toBe(false)
    expect(organizationCreateSchema.parse(base).budgetsEnabled).toBe(false)
    expect(organizationCreateSchema.parse({ ...base, budgetsEnabled: true }).budgetsEnabled).toBe(true)
  })

  it("accepts only a real boolean, on create and on edit", () => {
    for (const value of ["true", "false", 1, 0, null]) {
      expect(organizationCreateSchema.safeParse({ ...base, budgetsEnabled: value }).success).toBe(false)
      expect(organizationUpdateSchema.safeParse({ budgetsEnabled: value }).success).toBe(false)
    }
  })

  it("leaves the setting alone on an edit that does not mention it", () => {
    expect(organizationUpdateSchema.parse({ name: "Acme Traders Ltd" }).budgetsEnabled).toBeUndefined()
    expect(organizationUpdateSchema.parse({ budgetsEnabled: false }).budgetsEnabled).toBe(false)
  })

  it("still rejects unknown fields beside it", () => {
    expect(organizationUpdateSchema.safeParse({ budgetsEnabled: true, budgetsDisabled: true }).success).toBe(false)
  })

  it("names the audit action and refusal code the routes use", () => {
    expect(ORGANIZATION_BUDGETS_AUDIT_ACTION).toBe("UPDATE_ORGANIZATION_BUDGETS_ENABLED")
    expect(BUDGETS_DISABLED_CODE).toBe("BUDGETS_DISABLED")
  })
})
