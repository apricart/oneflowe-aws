import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { callsTo, installFetch, renderWithApp, resetUi } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())
const toast = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast, toasts: [], dismiss: vi.fn() }), toast }))

import { GroupManagement } from "./group-management"

/**
 * Group management as Head Office uses it: list, create, rename, delete with
 * confirmation, and the branch-assignment dialog — including the server's
 * refusal for a branch that already belongs to another group, which must be
 * shown to the user as it was sent.
 */
const GROUPS = [
  { id: 7, organizationId: 5, organizationName: "Acme", name: "Distribution", description: null, status: "active", branchCount: 1 },
  { id: 8, organizationId: 5, organizationName: "Acme", name: "Enabling", description: "Support", status: "active", branchCount: 0 },
]
const BRANCHES = [
  { id: 11, name: "North", organizationId: 5, groupId: 7, status: "active" },
  { id: 12, name: "South", organizationId: 5, groupId: null, status: "active" },
  { id: 13, name: "East", organizationId: 5, groupId: 8, status: "active" },
]

function routes(branchPut: unknown = { message: "ok", newlyAddedBranchIds: [12] }) {
  installFetch([
    ["/api/v1/groups", (url: URL, init?: RequestInit) => (init?.method === "POST" ? { group: { id: 9 } } : { groups: GROUPS })],
    [/^\/api\/v1\/groups\/\d+\/branch-counts/, { counts: { 11: 3 } }],
    [/^\/api\/v1\/groups\/\d+\/branches$/, (_url: URL, init?: RequestInit) => (init?.method === "PUT" ? branchPut : { items: BRANCHES.filter((b) => b.groupId === 7) })],
    [/^\/api\/v1\/groups\/\d+$/, { success: true }],
    ["/api/v1/branches", { items: BRANCHES }],
    ["/api/v1/organizations", { items: [{ id: 5, name: "Acme" }] }],
  ])
}

function groupRow(name: string) {
  return screen.getAllByText(name).map((node) => node.closest("tr")).find(Boolean) as HTMLElement
}

beforeEach(() => {
  resetUi({ id: "ho", role: "HEAD_OFFICE", organizationId: 5 })
  toast.mockClear()
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})

describe("Group management", () => {
  it("lists the organization's groups", async () => {
    routes()
    renderWithApp(<GroupManagement role="HEAD_OFFICE" />)
    expect((await screen.findAllByText("Distribution")).length).toBeGreaterThan(0)
    expect(screen.getAllByText("Enabling").length).toBeGreaterThan(0)
    await waitFor(() => expect(callsTo("/api/v1/groups").some((call) => call.url.includes("organizationId=5"))).toBe(true))
  })

  it("creates a group in the caller's organization", async () => {
    routes()
    renderWithApp(<GroupManagement role="HEAD_OFFICE" />)
    await screen.findAllByText("Distribution")

    fireEvent.click(screen.getByText("Create Group"))
    fireEvent.change(await screen.findByPlaceholderText("e.g. Downtown Stores"), { target: { value: "Generation" } })
    fireEvent.change(screen.getByPlaceholderText("Group purpose..."), { target: { value: "Plants" } })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))

    await waitFor(() => expect(callsTo("/api/v1/groups", "POST")).toHaveLength(1))
    expect(callsTo("/api/v1/groups", "POST")[0].body).toEqual({ name: "Generation", description: "Plants", organizationId: 5 })
  })

  it("renames a group", async () => {
    routes()
    renderWithApp(<GroupManagement role="HEAD_OFFICE" />)
    await screen.findAllByText("Distribution")

    const buttons = within(groupRow("Enabling")).getAllByRole("button")
    fireEvent.click(buttons.at(-2)!)
    const name = await screen.findByDisplayValue("Enabling")
    fireEvent.change(name, { target: { value: "Enabling Services" } })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    await waitFor(() => expect(callsTo("/api/v1/groups/8", "PUT")).toHaveLength(1))
    expect(callsTo("/api/v1/groups/8", "PUT")[0].body).toMatchObject({ name: "Enabling Services" })
  })

  it("deletes a group only after confirmation", async () => {
    routes()
    renderWithApp(<GroupManagement role="HEAD_OFFICE" />)
    await screen.findAllByText("Distribution")

    fireEvent.click(within(groupRow("Enabling")).getAllByRole("button").at(-1)!)
    expect(callsTo("/api/v1/groups/8", "DELETE")).toHaveLength(0)
    fireEvent.click(await screen.findByRole("button", { name: "Delete Group" }))
    await waitFor(() => expect(callsTo("/api/v1/groups/8", "DELETE")).toHaveLength(1))
  })

  it("assigns branches and shows the server's refusal word for word", async () => {
    routes({ status: 409, body: { error: "These branches are already assigned to another group: East. Please release them first." } })
    renderWithApp(<GroupManagement role="HEAD_OFFICE" />)
    await screen.findAllByText("Distribution")

    fireEvent.click(within(groupRow("Distribution")).getByTitle("Manage Branches"))
    await screen.findByText(/Assign Branches - Distribution/)
    fireEvent.click(await screen.findByText(/Save Assignments/))

    await waitFor(() => expect(callsTo("/api/v1/groups/7/branches", "PUT")).toHaveLength(1))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Error",
      description: "These branches are already assigned to another group: East. Please release them first.",
    })))
  })

  it("hides the create button from roles that may not create", async () => {
    resetUi({ id: "gu", role: "GROUP_USER", organizationId: 5 })
    routes()
    renderWithApp(<GroupManagement role="GROUP_USER" />)
    await screen.findAllByText("Distribution")
    expect(screen.queryByText("Create Group")).toBeNull()
  })
})
