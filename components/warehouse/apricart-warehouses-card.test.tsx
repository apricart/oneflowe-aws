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
  members: [{ userId: WH_OPERATOR, responsibility: "WAREHOUSE_OPERATOR" }],
  routedBranchCount: 1,
  executiveGapOrganizationIds: [1],
  ...overrides,
})

const configuration = {
  warehouses: [warehouse(), warehouse({ id: 2, code: "LHR-01", name: "Lahore", members: [{ userId: WH_OTHER, responsibility: "WAREHOUSE_OPERATOR" }], routedBranchCount: 0, executiveGapOrganizationIds: [] })],
  accounts: [
    { id: WH_OPERATOR, fullName: "Kamran Store", username: "kamran.wh", email: "kamran@example.test", isActive: true, responsibility: "WAREHOUSE_OPERATOR" },
    { id: WH_OTHER, fullName: "Nadia Dock", username: "nadia.wh", email: "nadia@example.test", isActive: true, responsibility: "WAREHOUSE_OPERATOR" },
    { id: EXECUTIVE, fullName: "Asma Exec", username: "asma.exec", email: "asma@example.test", isActive: true, responsibility: "EXECUTIVE" },
  ],
  routes: [{ branchId: 13, warehouseId: 1 }],
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
  it("says plainly what membership does and that default warehouses move no order", () => {
    render(<ApricartWarehousesCard />)
    expect(screen.getByText(/operators fulfil the orders Super Admin transfers to it/)).toBeTruthy()
    expect(screen.getByText(/default warehouses do not move any order/)).toBeTruthy()
  })

  it("lists each warehouse with its members and routed branches", () => {
    render(<ApricartWarehousesCard />)
    const row = rowOf("KHI-01")
    expect(within(row).getByText("1 operator")).toBeTruthy()
    expect(within(row).getByText("0 executives")).toBeTruthy()
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
    fireEvent.click(within(rowOf("KHI-01")).getByRole("button", { name: "Branches" }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText("Suggested")).toBeTruthy()
    expect(within(dialog).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true)

    fireEvent.click(within(dialog).getByRole("button", { name: "Tick suggested (1)" }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/apricart-warehouses/1/branches")
    expect(sentBody(0)).toEqual({ organizationId: 1, branchIds: [12, 13] })
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
