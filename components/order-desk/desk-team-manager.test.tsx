import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const swr = vi.hoisted(() => ({ team: undefined as unknown, executives: undefined as unknown, mutate: vi.fn() }))

vi.mock("swr", () => ({
  default: (key: string) => {
    if (key === "/api/v1/apricart-executives") return { data: swr.executives, error: undefined, isLoading: false, mutate: swr.mutate }
    return { data: swr.team, error: undefined, isLoading: false, mutate: swr.mutate }
  },
}))
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }))

import { DeskTeamManager } from "./desk-team-manager"

const managedOrganizations = [
  { id: 1, name: "Meezan", code: "MEZ", status: "active", branches: [{ id: 11, name: "North", status: "active" }, { id: 12, name: "South", status: "active" }] },
  { id: 2, name: "UBL", code: "UBL", status: "active", branches: [{ id: 21, name: "Clifton", status: "active" }] },
]

const member = (overrides: Record<string, unknown> = {}) => ({
  id: "0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4",
  fullName: "Sana Desk",
  username: "sana.desk",
  email: "sana@example.test",
  isActive: true,
  mustChangePassword: false,
  organizationIds: [1],
  branchIds: [21],
  ...overrides,
})

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  swr.mutate.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("Order Desk Team", () => {
  it("lists each desk user with what they may order for", () => {
    swr.team = { members: [member()], managedOrganizations }
    render(<DeskTeamManager />)
    const row = screen.getByText("Sana Desk").closest("tr")!
    expect(within(row).getByText("Meezan (all branches); UBL: Clifton")).toBeTruthy()
    expect(within(row).getByText("Active")).toBeTruthy()
  })

  it("says what to do first when no organization is managed yet", () => {
    swr.team = { members: [member({ organizationIds: [], branchIds: [] })], managedOrganizations: [] }
    render(<DeskTeamManager />)
    fireEvent.click(screen.getByRole("button", { name: "Access" }))
    expect(screen.getByText(/No organization is managed by the Order Desk yet/)).toBeTruthy()
  })

  it("saves access without a grant to an organization that is no longer managed", async () => {
    // Organization 9 (and its branch 91) stopped being managed after Sana was
    // granted it. It has no checkbox, and the server refuses to store it again.
    swr.team = { members: [member({ organizationIds: [1, 9], branchIds: [21, 91] })], managedOrganizations }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ item: {} }), { status: 200 }))
    render(<DeskTeamManager />)

    fireEvent.click(screen.getByRole("button", { name: "Access" }))
    const dialog = screen.getByRole("dialog")
    expect((within(dialog).getByLabelText("Meezan — all branches") as HTMLButtonElement).getAttribute("data-state")).toBe("checked")
    fireEvent.click(within(dialog).getByRole("button", { name: "Save access" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/order-desk/team/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4/assignments")
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ organizationIds: [1], branchIds: [21] })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("narrows a whole grant to single branches when the organization is unticked", async () => {
    swr.team = { members: [member({ organizationIds: [1], branchIds: [] })], managedOrganizations }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ item: {} }), { status: 200 }))
    render(<DeskTeamManager />)

    fireEvent.click(screen.getByRole("button", { name: "Access" }))
    const dialog = screen.getByRole("dialog")
    fireEvent.click(within(dialog).getByLabelText("Meezan — all branches"))
    fireEvent.click(within(dialog).getByLabelText("South"))
    fireEvent.click(within(dialog).getByRole("button", { name: "Save access" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ organizationIds: [], branchIds: [12] })
  })

  it("keeps the dialog open with the server's reason when access is refused", async () => {
    swr.team = { members: [member()], managedOrganizations }
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: "Only organizations marked as managed by the Order Desk can be assigned" }),
      { status: 400 },
    ))
    render(<DeskTeamManager />)
    fireEvent.click(screen.getByRole("button", { name: "Access" }))
    fireEvent.click(screen.getByRole("button", { name: "Save access" }))
    expect(await screen.findByText("Only organizations marked as managed by the Order Desk can be assigned")).toBeTruthy()
    expect(screen.getByRole("dialog")).toBeTruthy()
  })

  it("deactivates a desk user through the access route, sending nothing but the switch", async () => {
    swr.team = { members: [member()], managedOrganizations }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
    render(<DeskTeamManager />)
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }))
    await waitFor(() => expect(swr.mutate).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/users/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4/access")
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PATCH")
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ isActive: false })
  })

  it("creates a desk user with no tenant, then grants the ticked reach", async () => {
    swr.team = { members: [], managedOrganizations }
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ item: { id: "new-desk-user" } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ item: {} }), { status: 200 }))
    render(<DeskTeamManager />)
    expect(screen.getByText("No desk users yet.")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /Add desk user/ }))
    const dialog = screen.getByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("First name"), { target: { value: "Ali" } })
    fireEvent.change(within(dialog).getByLabelText("Last name"), { target: { value: "Raza" } })
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "ali@example.test" } })
    fireEvent.change(within(dialog).getByLabelText("Username"), { target: { value: "ali.desk" } })
    fireEvent.change(within(dialog).getByLabelText("Temporary password"), { target: { value: "Str0ng!Passw0rd" } })
    fireEvent.click(within(dialog).getByLabelText("UBL — all branches"))
    fireEvent.click(within(dialog).getByRole("button", { name: "Create desk user" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/users")
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({
      role: "ORDER_DESK",
      organizationId: null,
      branchId: null,
      username: "ali.desk",
    })
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/order-desk/team/new-desk-user/assignments")
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({ organizationIds: [2], branchIds: [] })
  })
})
