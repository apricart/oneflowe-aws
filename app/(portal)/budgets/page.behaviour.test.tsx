import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { addonValidityBounds } from "@/lib/budget-addon-expiry"
import { callsTo, installFetch, renderWithApp, resetUi, ui } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())
const toast = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast, toasts: [], dismiss: vi.fn() }), toast }))

import BudgetsPage from "./page"

/**
 * The money budget screen, rendered with its real table, filters and dialogs.
 * Only the network is faked. Every figure asserted is computed by hand from
 * the two rows below.
 *
 *   North: allocated 1,000.00, add-on 200.00, spent 300.00, held 100.00 -> remaining 800.00
 *   South: allocated   500.00, add-on   0.00, spent   0.00, held   0.00 -> remaining 500.00
 */
const NORTH = {
  branchId: 11,
  branchName: "North",
  organizationId: 5,
  groupId: 7,
  baselineBudgetCents: 100_000,
  amountAllocatedCents: 100_000,
  amountCreditedCents: 20_000,
  amountSpentCents: 30_000,
  amountHeldCents: 10_000,
  remainingCents: 80_000,
  budgetAllocationMode: "money",
}
const SOUTH = {
  branchId: 12,
  branchName: "South",
  organizationId: 5,
  groupId: 7,
  baselineBudgetCents: 50_000,
  amountAllocatedCents: 50_000,
  amountCreditedCents: 0,
  amountSpentCents: 0,
  amountHeldCents: 0,
  remainingCents: 50_000,
  budgetAllocationMode: "money",
}

const VALID_UNTIL = addonValidityBounds(new Date()).max

function routes(budgets = [NORTH, SOUTH], extra: Record<string, unknown> = {}, put: unknown = { ok: true }) {
  installFetch([
    [/^\/api\/v1\/budgets\?/, { budgets, budgetsEnabled: true, ...extra }],
    ["/api/v1/budgets", put],
    ["/api/v1/settings", { data: [] }],
    ["/api/v1/groups", { items: [{ id: 7, name: "Distribution" }] }],
    ["/api/v1/branches", { items: [{ id: 11, name: "North" }, { id: 12, name: "South" }] }],
  ])
}

function rowFor(name: string) {
  const cell = screen.getAllByText(name).find((element) => element.closest("tr"))
  return cell!.closest("tr") as HTMLElement
}

beforeEach(() => {
  resetUi({ id: "ho-1", role: "HEAD_OFFICE", organizationId: 5 })
  toast.mockClear()
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("Budgets page", () => {
  it("refuses roles that do not manage money budgets", () => {
    resetUi({ id: "op-1", role: "ORDER_PORTAL", organizationId: 5 })
    routes()
    renderWithApp(<BudgetsPage />)
    expect(screen.getByText("You do not have permission to access this page")).toBeTruthy()
    expect(callsTo(/^\/api\/v1\/budgets/)).toHaveLength(0)
  })

  it("asks for the organization's budgets and shows each branch with its remaining money", async () => {
    routes()
    renderWithApp(<BudgetsPage />)

    await screen.findByText("North")
    const request = callsTo(/^\/api\/v1\/budgets\?/)[0]
    expect(request.url).toContain("organizationId=5")
    expect(request.url).toContain("all=true")

    expect(within(rowFor("North")).getByText(/^Rs\s?800\.00$/)).toBeTruthy()
    expect(rowFor("South").lastElementChild?.previousElementSibling?.textContent).toMatch(/^Rs\s?500\.00$/)
  })

  it("shows the disabled notice when the organization has budgets switched off", async () => {
    routes([], { budgetsEnabled: false })
    renderWithApp(<BudgetsPage />)
    await waitFor(() => expect(screen.queryByText("North")).toBeNull())
    await waitFor(() => expect(document.body.textContent).toMatch(/budget/i))
  })

  it("filters branches by the search box and says so when nothing matches", async () => {
    routes()
    renderWithApp(<BudgetsPage />)
    await screen.findByText("North")

    fireEvent.change(screen.getByPlaceholderText("Search branches..."), { target: { value: "sou" } })
    expect(screen.queryByText("North")).toBeNull()
    expect(screen.getAllByText("South").length).toBeGreaterThan(0)

    fireEvent.change(screen.getByPlaceholderText("Search branches..."), { target: { value: "zzz" } })
    expect(screen.getByText("No branches match your search")).toBeTruthy()
  })

  it("sorts by remaining money, both ways", async () => {
    routes()
    renderWithApp(<BudgetsPage />)
    await screen.findByText("North")

    const order = () => screen.getAllByRole("row").slice(1).map((row) => row.textContent?.includes("North") ? "N" : "S")
    fireEvent.click(screen.getByText("Branch"))
    expect(order()).toEqual(["S", "N"])
    fireEvent.click(screen.getByText("Branch"))
    expect(order()).toEqual(["N", "S"])
  })

  it("refuses an add-on without a validity date, then applies one with it", async () => {
    routes()
    renderWithApp(<BudgetsPage />)
    await screen.findByText("North")

    fireEvent.click(within(rowFor("North")).getByText("Allocate"))
    fireEvent.change(await screen.findByPlaceholderText("0.00"), { target: { value: "150" } })
    fireEvent.click(screen.getByText("Apply Add-on"))
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Validity required" }))
    expect(callsTo("/api/v1/budgets", "PUT")).toHaveLength(0)

    // The shared Button disables itself while its async handler is in flight.
    await waitFor(() => expect((screen.getByText("Apply Add-on").closest("button") as HTMLButtonElement).disabled).toBe(false))
    const dateInput = document.getElementById("budget-addon-valid-until") as HTMLInputElement
    fireEvent.change(dateInput, { target: { value: VALID_UNTIL } })
    fireEvent.click(screen.getByText("Apply Add-on"))

    await waitFor(() => expect(callsTo("/api/v1/budgets", "PUT")).toHaveLength(1))
    expect(callsTo("/api/v1/budgets", "PUT")[0].body).toEqual({
      branchId: 11,
      amountAllocatedCents: 15_000,
      type: "addon",
      validUntil: VALID_UNTIL,
    })
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Budget Updated" })))
    const description = toast.mock.calls.find(([arg]) => arg.title === "Budget Updated")![0].description as string
    expect(description).toMatch(/^Added Rs\s?150\.00 to North\. New remaining: Rs\s?950\.00$/)
  })

  it("reports a monthly base as set, not added, with the remaining it really leaves", async () => {
    routes()
    renderWithApp(<BudgetsPage />)
    await screen.findByText("North")

    fireEvent.click(within(rowFor("North")).getByText("Allocate"))
    fireEvent.click(await screen.findByText("Monthly Base"))
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "500" } })
    fireEvent.click(screen.getByText("Update Baseline"))

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Budget Updated" })))
    expect(callsTo("/api/v1/budgets", "PUT")[0].body).toEqual({ branchId: 11, amountAllocatedCents: 50_000, type: "monthly" })
    const description = toast.mock.calls.find(([arg]) => arg.title === "Budget Updated")![0].description as string
    // 800.00 remaining - 1,000.00 old allocation + 500.00 new allocation = 300.00
    expect(description).toMatch(/^Set the monthly budget of North to Rs\s?500\.00\. New remaining: Rs\s?300\.00$/)
  })

  it("blocks a monthly base below what the branch has already committed", async () => {
    routes()
    renderWithApp(<BudgetsPage />)
    await screen.findByText("North")

    fireEvent.click(within(rowFor("North")).getByText("Allocate"))
    fireEvent.click(await screen.findByText("Monthly Base"))
    // 100.00 base + 200.00 add-on = 300.00 < 400.00 spent and held
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "100" } })
    fireEvent.click(screen.getByText("Update Baseline"))

    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Allocation Blocked" }))
    expect(callsTo("/api/v1/budgets", "PUT")).toHaveLength(0)
  })

  it("shows the server's refusal", async () => {
    routes(undefined, {}, { status: 409, body: { error: "Budget below committed" } })
    renderWithApp(<BudgetsPage />)
    await screen.findByText("North")

    fireEvent.click(within(rowFor("South")).getByText("Allocate"))
    fireEvent.click(await screen.findByText("Monthly Base"))
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "10" } })
    fireEvent.click(screen.getByText("Update Baseline"))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Failed", description: "Budget below committed" })))
  })

  it("will not empty a branch that has spending, and empties one that has none", async () => {
    routes()
    renderWithApp(<BudgetsPage />)
    await screen.findByText("North")

    fireEvent.click(within(rowFor("North")).getByTitle("Reset budget to zero"))
    fireEvent.click(await screen.findByText("Empty Budget"))
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Cannot Reset Budget" }))
    expect(callsTo("/api/v1/budgets", "PUT")).toHaveLength(0)

    fireEvent.click(screen.getByText("Cancel"))
    fireEvent.click(within(rowFor("South")).getByTitle("Reset budget to zero"))
    fireEvent.click(await screen.findByText("Empty Budget"))
    await waitFor(() => expect(callsTo("/api/v1/budgets", "PUT")).toHaveLength(1))
    expect(callsTo("/api/v1/budgets", "PUT")[0].body).toEqual({
      branchId: 12,
      amountAllocatedCents: 0,
      setAbsolute: true,
      resetAddons: true,
    })
  })

  it("bulk-allocates to every money branch in view and reports how many succeeded", async () => {
    routes()
    renderWithApp(<BudgetsPage />)
    await screen.findByText("North")

    fireEvent.click(screen.getByText("Bulk Allocate"))
    fireEvent.change(document.getElementById("bulk-budget-amount")!, { target: { value: "250" } })
    fireEvent.click(screen.getByText("Allocate All Branches"))

    await waitFor(() => expect(callsTo("/api/v1/budgets", "PUT")).toHaveLength(2))
    expect(callsTo("/api/v1/budgets", "PUT").map((call) => call.body)).toEqual([
      { branchId: 11, amountAllocatedCents: 25_000 },
      { branchId: 12, amountAllocatedCents: 25_000 },
    ])
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Bulk Allocation Complete" })))
  })

  it("empties every branch in view on confirmation", async () => {
    routes()
    renderWithApp(<BudgetsPage />)
    await screen.findByText("North")

    fireEvent.click(screen.getByText("Empty All"))
    fireEvent.click(await screen.findByText("Empty All Budgets"))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Bulk Empty Complete",
      description: "Reset 2/2 branch budgets to ₨0.00",
    })))
  })

  it("disables money allocation for a quantity-budget organization", async () => {
    routes([{ ...NORTH, budgetAllocationMode: "quantity" }])
    installFetch([
      [/^\/api\/v1\/budgets\?/, { budgets: [{ ...NORTH, budgetAllocationMode: "quantity" }], budgetsEnabled: true }],
      ["/api/v1/settings", { data: [{ key: "budget_allocation_mode", value: "quantity" }] }],
    ])
    renderWithApp(<BudgetsPage />)
    await screen.findByText("North")
    const allocate = within(rowFor("North")).getByText("Allocate").closest("button") as HTMLButtonElement
    expect(allocate.disabled).toBe(true)
    expect(ui.unmatched.filter((call) => call.includes("/budgets"))).toEqual([])
  })
})
