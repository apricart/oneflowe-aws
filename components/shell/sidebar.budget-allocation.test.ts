import { describe, expect, it } from "vitest"
import { getNavigationByRole } from "@/components/shell/sidebar"

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
