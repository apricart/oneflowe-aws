import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const swr = vi.hoisted(() => ({ configuration: undefined as unknown, team: undefined as unknown, mutate: vi.fn() }))

vi.mock("swr", () => ({
  default: (key: string) => {
    if (key === "/api/v1/apricart-warehouses") return { data: swr.configuration, error: undefined, isLoading: false, mutate: swr.mutate }
    if (key === "/api/v1/warehouse-team") return { data: swr.team, error: undefined, isLoading: false, mutate: vi.fn() }
    throw new Error(`unexpected key ${key}`)
  },
}))
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }))

import { ApricartWarehousesCard } from "./apricart-warehouses-card"

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView ??= vi.fn()

const WH_OPERATOR = "0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4"
const WH_OTHER = "1c9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4"
const EXECUTIVE = "2d9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4"

const team = {
  members: [
    { id: WH_OPERATOR, fullName: "Kamran Store", email: "kamran@example.test", isActive: true, branchIds: [11, 12], cityKeys: [] },
    { id: WH_OTHER, fullName: "Nadia Dock", email: "nadia@example.test", isActive: true, branchIds: [11], cityKeys: [] },
    { id: "gone", fullName: "Old Hand", email: "old@example.test", isActive: false, branchIds: [21], cityKeys: [] },
  ],
  organizations: [{ id: 1, name: "Meezan" }, { id: 2, name: "UBL" }],
  branches: [
    { id: 11, organizationId: 1, name: "North", city: "Lahore", status: "active" },
    { id: 12, organizationId: 1, name: "Saddar", city: "Karachi", status: "active" },
    { id: 13, organizationId: 1, name: "Gulberg", city: "Lahore", status: "active" },
    { id: 21, organizationId: 2, name: "Clifton", city: "Karachi", status: "active" },
  ],
}

const warehouse = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  code: "KHI-01",
  name: "Karachi Central",
  city: "Karachi",
  address: null,
  contactPhone: null,
  status: "ACTIVE",
  members: [{ userId: WH_OPERATOR, responsibility: "WAREHOUSE_OPERATOR", branchScope: "ALL", selectedBranchIds: [] }],
  routedBranchCount: 1,
  ruleCount: 1,
  branchCount: 2,
  executiveGapOrganizationIds: [1],
  ...overrides,
})

const configuration = {
  ownershipMode: "branch",
  warehouses: [warehouse(), warehouse({ id: 2, code: "LHR-01", name: "Lahore", members: [{ userId: WH_OTHER, responsibility: "WAREHOUSE_OPERATOR", branchScope: "ALL", selectedBranchIds: [] }], routedBranchCount: 0, ruleCount: 0, branchCount: 0, executiveGapOrganizationIds: [] })],
  accounts: [
    { id: WH_OPERATOR, fullName: "Kamran Store", username: "kamran.wh", email: "kamran@example.test", isActive: true, responsibility: "WAREHOUSE_OPERATOR" },
    { id: WH_OTHER, fullName: "Nadia Dock", username: "nadia.wh", email: "nadia@example.test", isActive: true, responsibility: "WAREHOUSE_OPERATOR" },
    { id: EXECUTIVE, fullName: "Asma Exec", username: "asma.exec", email: "asma@example.test", isActive: true, responsibility: "EXECUTIVE" },
  ],
  routes: [{ branchId: 13, warehouseId: 1 }],
  rules: [
    { id: 5, warehouseId: 1, organizationId: 1, cityKey: "karachi", cityLabel: "Karachi", branchCount: 1 },
    { id: 6, warehouseId: 2, organizationId: 2, cityKey: "karachi", cityLabel: "Karachi", branchCount: 1 },
  ],
  cityOptions: [
    { organizationId: 1, cityKey: "karachi", label: "Karachi", branchCount: 1 },
    { organizationId: 1, cityKey: "lahore", label: "Lahore", branchCount: 2 },
    { organizationId: 2, cityKey: "karachi", label: "Karachi", branchCount: 1 },
  ],
  branchWarehouses: [{ branchId: 12, warehouseId: 1 }, { branchId: 13, warehouseId: 1 }],
  unrouted: { count: 1, orders: [{ id: 900, tid: "TID-900", organizationId: 2, branchId: 21, status: "APPROVED", fulfillmentStatus: "IN_PROCESS" }] },
  coverage: {
    summary: { ROUTED: 1, SUGGESTED: 1, AMBIGUOUS: 1, UNMAPPED: 0, UNSERVED: 1 },
    branches: [
      { branchId: 11, organizationId: 1, kind: "AMBIGUOUS", routeWarehouseId: null, routeMatchesReach: null, suggestedWarehouseId: null, candidateWarehouseIds: [1, 2], servingAccountIds: [WH_OPERATOR, WH_OTHER] },
      { branchId: 12, organizationId: 1, kind: "SUGGESTED", routeWarehouseId: null, routeMatchesReach: null, suggestedWarehouseId: 1, candidateWarehouseIds: [1], servingAccountIds: [WH_OPERATOR] },
      { branchId: 13, organizationId: 1, kind: "ROUTED", routeWarehouseId: 1, routeMatchesReach: null, suggestedWarehouseId: null, candidateWarehouseIds: [], servingAccountIds: [] },
      { branchId: 21, organizationId: 2, kind: "UNSERVED", routeWarehouseId: null, routeMatchesReach: null, suggestedWarehouseId: null, candidateWarehouseIds: [], servingAccountIds: [] },
    ],
  },
}

const fetchMock = vi.fn()
const sentBody = (call: number) => JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body))
const rowOf = (code: string) => screen.getByText(new RegExp(`^${code} ·`)).closest("tr")!

/** Opens a multi-select, ticks the named options, and closes it again. */
const choose = (dialog: HTMLElement, label: string, options: string[]) => {
  fireEvent.click(within(dialog).getByRole("combobox", { name: label }))
  for (const option of options) fireEvent.click(screen.getByRole("option", { name: new RegExp(option) }))
  fireEvent.keyDown(screen.getByLabelText(`Search ${label.toLowerCase()}`), { key: "Escape" })
}

beforeEach(() => {
  fetchMock.mockReset()
  swr.mutate.mockReset()
  swr.configuration = configuration
  swr.team = team
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("Apricart warehouses", () => {
  it("says plainly that, today, every order is still worked by the accounts assigned its branch", () => {
    render(<ApricartWarehousesCard />)
    expect(screen.getByText(/Today every order is still worked by the accounts assigned its branch on Warehouse Team/)).toBeTruthy()
    expect(screen.getByText(/run the check below/)).toBeTruthy()
  })

  it("says, once warehouses decide, that they do", () => {
    swr.configuration = { ...configuration, ownershipMode: "membership" }
    render(<ApricartWarehousesCard />)
    expect(screen.getByText(/Apricart's warehouses decide who works each order/)).toBeTruthy()
  })

  it("lists each warehouse with its members, its live branches, its rules and its branches by hand", () => {
    render(<ApricartWarehousesCard />)
    const row = rowOf("KHI-01")
    expect(within(row).getByText("1 operator")).toBeTruthy()
    expect(within(row).getByText("0 executives")).toBeTruthy()
    expect(within(row).getByText("2 active")).toBeTruthy()
    expect(within(row).getByText("1 rule · 1 by hand")).toBeTruthy()
  })

  it("adds a rule as an organization, a city key and a yes — never a warehouse in the body", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }))
    render(<ApricartWarehousesCard />)
    fireEvent.click(within(rowOf("KHI-01")).getByRole("button", { name: "Rules" }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText(/Meezan · Karachi/)).toBeTruthy()

    expect(within(dialog).getByRole("button", { name: "Add rule" }).hasAttribute("disabled")).toBe(true)

    // The organization's whole, with no city chosen: an organization rule.
    choose(dialog, "Organizations", ["Meezan"])
    fireEvent.click(within(dialog).getByRole("button", { name: "Add rule" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/apricart-warehouses/1/rules")
    expect(sentBody(0)).toEqual({ organizationId: 1, city: null, assigned: true })
    expect(swr.mutate).toHaveBeenCalled()
  })

  it("removes only the rule asked for", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }))
    render(<ApricartWarehousesCard />)
    fireEvent.click(within(rowOf("KHI-01")).getByRole("button", { name: "Rules" }))
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove Meezan · Karachi" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(sentBody(0)).toEqual({ organizationId: 1, city: "karachi", assigned: false })
  })

  it("narrows an operator to ticked branches of the warehouse, one organization at a time", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }))
    render(<ApricartWarehousesCard />)
    fireEvent.click(within(rowOf("KHI-01")).getByRole("button", { name: "Members" }))
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "All branches" }))
    const dialog = screen.getAllByRole("dialog").at(-1)!
    // Only the warehouse's branches are offered: Saddar and Gulberg, not North.
    expect(within(dialog).getByLabelText(/Saddar/)).toBeTruthy()
    expect(within(dialog).queryByLabelText(/North/)).toBeNull()
    fireEvent.click(within(dialog).getByLabelText(/Gulberg/))
    fireEvent.click(within(dialog).getByRole("button", { name: "Work only the ticked branches" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/apricart-warehouses/1/member-scope")
    expect(sentBody(0)).toEqual({ userId: WH_OPERATOR, scope: "SELECTED", organizationId: 1, branchIds: [13] })
  })

  it("lists the open orders whose branch is in no warehouse", () => {
    render(<ApricartWarehousesCard />)
    expect(screen.getByText("Open orders whose branch is in no warehouse: 1")).toBeTruthy()
    expect(screen.getByText("TID-900")).toBeTruthy()
  })

  it("runs the ownership check on demand and says whether anyone's work would change", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      checkedAt: "2026-10-28T10:00:00.000Z",
      accounts: [{ id: WH_OPERATOR, username: "kamran.wh", branchCount: 2 }],
      differences: { "membership-fallback": [], membership: [{ accountId: WH_OPERATOR, lost: [11], gained: [] }] },
      unroutedOpenOrders: 1,
      strandedBranches: [],
      ready: { "membership-fallback": true, membership: false },
    }), { status: 200 }))
    render(<ApricartWarehousesCard />)
    fireEvent.click(screen.getByRole("button", { name: "Run check" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/apricart-warehouses/ownership-check"))
    expect(await screen.findByText("No change")).toBeTruthy()
    expect(screen.getByText("Changes")).toBeTruthy()
    expect(screen.getByText("kamran.wh: loses 1, gains 0 branch(es)")).toBeTruthy()
  })

  it("reports what needs a decision: ambiguous branches, executive gaps and inactive holders", () => {
    render(<ApricartWarehousesCard />)
    expect(screen.getByText("Ambiguous: 1")).toBeTruthy()
    expect(screen.getByText(/Served by Kamran Store, Nadia Dock at KHI-01, LHR-01/)).toBeTruthy()
    expect(screen.getByText(/has no executive member for Meezan/)).toBeTruthy()
    expect(screen.getByText(/Inactive accounts still holding assignments: Old Hand/)).toBeTruthy()
  })

  it("sends a member change as the account and a yes/no — never a responsibility", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }))
    render(<ApricartWarehousesCard />)
    fireEvent.click(within(rowOf("KHI-01")).getByRole("button", { name: "Members" }))
    const dialog = screen.getByRole("dialog")
    fireEvent.click(within(dialog).getByLabelText(/Asma Exec/))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/apricart-warehouses/1/members")
    expect(sentBody(0)).toEqual({ userId: EXECUTIVE, assigned: true })
  })

  it("applies a suggestion only when Super Admin ticks it, and saves one organization's routes", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }))
    render(<ApricartWarehousesCard />)
    fireEvent.click(within(rowOf("KHI-01")).getByRole("button", { name: "By hand" }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText("Suggested")).toBeTruthy()
    expect(within(dialog).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true)

    fireEvent.click(within(dialog).getByRole("button", { name: "Tick suggested (1)" }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/apricart-warehouses/1/branches")
    expect(sentBody(0)).toEqual({ organizationId: 1, branchIds: [12, 13] })
  })

  it("searches organizations and selects only the branches shown by the filter", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }))
    render(<ApricartWarehousesCard />)
    fireEvent.click(within(rowOf("KHI-01")).getByRole("button", { name: "By hand" }))
    const dialog = screen.getByRole("dialog")

    fireEvent.click(within(dialog).getByRole("combobox", { name: "Organizations" }))
    fireEvent.change(screen.getByLabelText("Search organizations"), { target: { value: "ubl" } })
    fireEvent.click(screen.getByRole("option", { name: /UBL/ }))
    fireEvent.keyDown(screen.getByLabelText("Search organizations"), { key: "Escape" })
    // Both organizations are listed now, each branch naming its own.
    expect(within(dialog).getByLabelText(/Clifton/).closest("div")?.textContent).toContain("UBL")
    expect(within(dialog).getByLabelText(/North/)).toBeTruthy()

    fireEvent.change(within(dialog).getByLabelText("Filter branches"), { target: { value: "clif" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Select all shown" }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }))

    // Only the organization whose ticks changed is sent.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(sentBody(0)).toEqual({ organizationId: 2, branchIds: [21] })
  })

  it("saves branches ticked in several organizations, one request per organization", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }))
    render(<ApricartWarehousesCard />)
    fireEvent.click(within(rowOf("KHI-01")).getByRole("button", { name: "By hand" }))
    const dialog = screen.getByRole("dialog")
    choose(dialog, "Organizations", ["UBL"])

    fireEvent.click(within(dialog).getByLabelText(/Clifton/))
    fireEvent.click(within(dialog).getByLabelText(/North/))
    expect(within(dialog).getByText("Saves 2 organizations, one after another.")).toBeTruthy()
    // The organizations cannot change under unsaved ticks.
    expect(within(dialog).getByRole("combobox", { name: "Organizations" }).hasAttribute("disabled")).toBe(true)
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(sentBody(0)).toEqual({ organizationId: 1, branchIds: [11, 13] })
    expect(sentBody(1)).toEqual({ organizationId: 2, branchIds: [21] })
    await waitFor(() => expect(swr.mutate).toHaveBeenCalled())
  })

  it("searches the warehouse's rules by organization or city", () => {
    swr.configuration = {
      ...configuration,
      rules: [
        ...configuration.rules,
        { id: 7, warehouseId: 1, organizationId: 2, cityKey: null, cityLabel: null, branchCount: 1 },
      ],
    }
    render(<ApricartWarehousesCard />)
    fireEvent.click(within(rowOf("KHI-01")).getByRole("button", { name: "Rules" }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText("Rules (2)")).toBeTruthy()

    fireEvent.change(within(dialog).getByLabelText("Search rules"), { target: { value: "ubl" } })
    expect(within(dialog).getByText("Rules (1 of 2)")).toBeTruthy()
    expect(within(dialog).getByText(/UBL · all cities/)).toBeTruthy()
    expect(within(dialog).queryByText(/Meezan · Karachi/)).toBeNull()

    fireEvent.change(within(dialog).getByLabelText("Search rules"), { target: { value: "karachi meezan" } })
    expect(within(dialog).getByText(/Meezan · Karachi/)).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText("Search rules"), { target: { value: "quetta" } })
    expect(within(dialog).getByText("No rule matches.")).toBeTruthy()
  })

  it("adds one rule per chosen organization and city it has branches in, skipping the ones it holds", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }))
    render(<ApricartWarehousesCard />)
    fireEvent.click(within(rowOf("KHI-01")).getByRole("button", { name: "Rules" }))
    const dialog = screen.getByRole("dialog")
    choose(dialog, "Organizations", ["Meezan", "UBL"])
    choose(dialog, "Cities", ["Karachi", "Lahore"])

    // Meezan · Karachi is already this warehouse's; UBL has no Lahore branch; UBL · Karachi moves from LHR-01.
    expect(within(dialog).getByText(/1 of these is now in LHR-01/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole("button", { name: "Add 2 rules" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(sentBody(0)).toEqual({ organizationId: 1, city: "lahore", assigned: true })
    expect(sentBody(1)).toEqual({ organizationId: 2, city: "karachi", assigned: true })
    expect(swr.mutate).toHaveBeenCalled()
  })

  it("stops at the first refused rule and says how many were saved", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Too many requests. Please try again later." }), { status: 429 }))
    render(<ApricartWarehousesCard />)
    fireEvent.click(within(rowOf("KHI-01")).getByRole("button", { name: "Rules" }))
    const dialog = screen.getByRole("dialog")
    choose(dialog, "Organizations", ["Meezan", "UBL"])
    fireEvent.click(within(dialog).getByRole("button", { name: "Add 2 rules" }))

    expect(await within(dialog).findByRole("alert")).toHaveProperty(
      "textContent",
      "Too many requests. Please try again later. 1 of 2 rules were saved before this; the rest were not.",
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(swr.mutate).toHaveBeenCalled()
  })

  it("shows the server's refusal instead of claiming success", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "A warehouse with this code already exists" }), { status: 409 }))
    render(<ApricartWarehousesCard />)
    fireEvent.click(screen.getByRole("button", { name: "New warehouse" }))
    const dialog = screen.getByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("Code"), { target: { value: "khi-01" } })
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Karachi again" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }))
    expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "A warehouse with this code already exists")
    expect(sentBody(0)).toMatchObject({ code: "KHI-01", name: "Karachi again" })
    expect(swr.mutate).not.toHaveBeenCalled()
  })
})
