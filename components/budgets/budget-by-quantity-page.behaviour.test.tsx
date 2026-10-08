import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { callsTo, installFetch, renderWithApp, resetUi } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())
const toast = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast, toasts: [], dismiss: vi.fn() }), toast }))

import BudgetByQuantityPage from "./budget-by-quantity-page"

/**
 * Budget by Quantity with its real table, product breakdown and dialogs.
 *
 *   North: 50 base + 10 add-on = 60, 15 spent -> 45 remaining (Paper)
 *   South: nothing allocated yet
 */
const BUDGETS = [
  { branchId: 11, branchName: "North", organizationId: 5, groupId: 7, groupName: "Distribution", amountAllocatedCents: 0, amountCreditedCents: 0, amountSpentCents: 0, amountHeldCents: 0, remainingCents: 0, baselineBudgetCents: 0, budgetAllocationMode: "quantity" },
  { branchId: 12, branchName: "South", organizationId: 5, groupId: null, groupName: null, amountAllocatedCents: 0, amountCreditedCents: 0, amountSpentCents: 0, amountHeldCents: 0, remainingCents: 0, baselineBudgetCents: 0, budgetAllocationMode: "quantity" },
]
const QUANTITY = {
  branches: [{ branchId: 11, baseQuantity: 50, addonQuantity: 10, totalQuantity: 60, spentQuantity: 15, remainingQuantity: 45, productCount: 1 }],
  products: [{
    quantityBudgetId: 1, branchId: 11, organizationInventoryId: 21, globalProductId: 31, productCode: "PP", productName: "Paper A4",
    unit: "Ream", baseQuantity: 50, addonQuantity: 10, totalQuantity: 60, spentQuantity: 15, remainingQuantity: 45,
  }],
}

function routes(mode: "quantity" | "money" = "quantity", reset: unknown = { message: "reset", reset: { branchCount: 2 } }) {
  installFetch([
    ["/api/v1/settings", { data: [{ key: "budget_allocation_mode", value: mode }] }],
    [/^\/api\/v1\/organizations\/5/, { item: { id: 5, budgetsEnabled: true } }],
    [/^\/api\/v1\/budgets\?/, { budgets: BUDGETS, budgetsEnabled: true }],
    ["/api/v1/budget-quantity", (_url: URL, init?: RequestInit) => (init?.method === "DELETE" ? reset : QUANTITY)],
    ["/api/v1/branch/inventory", { items: [{ id: 41, name: "Paper A4", unit: "Ream", allowDecimalQuantity: false, quantityStep: 1 }], pricesHidden: false }],
    ["/api/v1/groups", { groups: [] }],
    ["/api/v1/branches", { items: [] }],
    ["/api/v1/analytics/earliest-record", { year: 2025 }],
  ])
}

function branchRow(name: string) {
  return screen.getAllByText(name).map((node) => node.closest("tr")).find(Boolean) as HTMLElement
}

beforeEach(() => {
  resetUi({ id: "ho", role: "HEAD_OFFICE", organizationId: 5 })
  toast.mockClear()
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})

describe("Budget by Quantity", () => {
  it("refuses roles that do not manage budgets", () => {
    resetUi({ id: "ba", role: "BRANCH_ADMIN", organizationId: 5, branchId: 11 })
    routes()
    renderWithApp(<BudgetByQuantityPage />)
    expect(screen.getByText("You do not have permission to access this page")).toBeTruthy()
  })

  it("explains that a money-mode organization has no quantity budgets", async () => {
    routes("money")
    renderWithApp(<BudgetByQuantityPage />)
    expect(await screen.findByText("This organization uses money-value budgeting. Quantity budgeting is not available.")).toBeTruthy()
    expect(callsTo("/api/v1/budget-quantity")).toHaveLength(0)
  })

  it("lists each branch's quantities and breaks a branch down by product", async () => {
    routes()
    renderWithApp(<BudgetByQuantityPage />)
    await screen.findAllByText("North")
    expect(within(branchRow("North")).getByText(/60/)).toBeTruthy()

    fireEvent.click(screen.getByLabelText("Show product quantity details for North"))
    expect(await screen.findByText("Paper A4")).toBeTruthy()
  })

  it("filters branches by name or group", async () => {
    routes()
    renderWithApp(<BudgetByQuantityPage />)
    await screen.findAllByText("North")
    fireEvent.change(screen.getByPlaceholderText("Search branches or groups..."), { target: { value: "distrib" } })
    await waitFor(() => expect(screen.queryAllByText("South")).toHaveLength(0))
    fireEvent.change(screen.getByPlaceholderText("Search branches or groups..."), { target: { value: "zzz" } })
    expect(await screen.findByText(/No branches/)).toBeTruthy()
  })

  it("resets every branch in view after confirmation", async () => {
    routes()
    renderWithApp(<BudgetByQuantityPage />)
    await screen.findAllByText("North")

    fireEvent.click(screen.getByRole("button", { name: /Empty All/ }))
    fireEvent.click(await screen.findByRole("button", { name: /Empty All Budgets/ }))
    await waitFor(() => expect(callsTo("/api/v1/budget-quantity", "DELETE")).toHaveLength(1))
    expect(callsTo("/api/v1/budget-quantity", "DELETE")[0].body).toMatchObject({ organizationId: "5" })
  })

  it("shows the server's refusal when a reset is blocked", async () => {
    routes("quantity", { status: 409, body: { error: "Cannot reset quantity budgets while orders are held or spent in the selected period" } })
    renderWithApp(<BudgetByQuantityPage />)
    await screen.findAllByText("North")
    fireEvent.click(screen.getByRole("button", { name: /Empty All/ }))
    fireEvent.click(await screen.findByRole("button", { name: /Empty All Budgets/ }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })))
  })

  it("opens the allocation dialog for a branch with nothing to apply yet", async () => {
    routes()
    renderWithApp(<BudgetByQuantityPage />)
    await screen.findAllByText("North")
    fireEvent.click(within(branchRow("South")).getByRole("button", { name: "Allocate" }))
    expect(await screen.findByText("Allocate Budget by Quantity")).toBeTruthy()
    await waitFor(() => expect(callsTo("/api/v1/branch/inventory").some((call) => call.url.includes("12"))).toBe(true))
    const apply = screen.getByRole("button", { name: "Apply Quantity Allocation" }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)

    fireEvent.click(screen.getByRole("button", { name: /Monthly|Base/ }))
    fireEvent.click(screen.getByRole("button", { name: "Add Product" }))
    expect(screen.getAllByPlaceholderText("0").length).toBeGreaterThan(1)
  })
})
