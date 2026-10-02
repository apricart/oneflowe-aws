import { describe, expect, it } from "vitest"
import { getNavigationByRole, withoutBudgetNavigation } from "@/components/shell/sidebar"

const hasBudgets = (role: string, enabled?: boolean) =>
  getNavigationByRole(role, enabled).some((item) => item.href === "/budgets")

describe("budget allocation navigation", () => {
  it("hides the Group User menu by default and shows it only with a grant", () => {
    expect(hasBudgets("GROUP_USER")).toBe(false)
    expect(hasBudgets("GROUP_USER", false)).toBe(false)
    expect(hasBudgets("GROUP_USER", true)).toBe(true)
  })

  it("keeps administrator navigation unchanged", () => {
    expect(hasBudgets("SUPER_ADMIN")).toBe(true)
    expect(hasBudgets("HEAD_OFFICE")).toBe(true)
    expect(hasBudgets("BRANCH_ADMIN", true)).toBe(false)
  })
})

describe("an organization with budget allocation off", () => {
  const hrefs = (role: string, organizationBudgetsEnabled: boolean) =>
    getNavigationByRole(role, true, organizationBudgetsEnabled).flatMap((item: any) => [
      item.href,
      ...(item.subItems ?? []).map((sub: { href: string }) => sub.href),
    ])
  const BUDGET_ONLY = ["/budgets", "/budget-by-quantity", "/reports/budget-summary"]

  it.each(["HEAD_OFFICE", "GROUP_USER", "SUPER_ADMIN"])("leaves every budget-only entry out for %s", (role) => {
    for (const href of BUDGET_ONLY) expect(hrefs(role, false)).not.toContain(href)
  })

  it("keeps everything else, including the other reports", () => {
    const on = hrefs("HEAD_OFFICE", true).filter((href) => !BUDGET_ONLY.includes(href))
    expect(hrefs("HEAD_OFFICE", false)).toEqual(on)
    expect(hrefs("HEAD_OFFICE", false)).toContain("/reports/order-report")
  })

  it("defaults to on, so an unanswered policy never hides a live budget", () => {
    expect(hasBudgets("HEAD_OFFICE")).toBe(true)
    expect(withoutBudgetNavigation([{ href: "/budgets" }, { href: "/orders" }])).toEqual([{ href: "/orders" }])
  })
})
