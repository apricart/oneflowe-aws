import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { callsTo, installFetch, renderWithApp, resetUi } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())
vi.mock("xlsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("xlsx")>()
  return { ...actual, writeFile: vi.fn() }
})

import { HeadOfficeUsersTable } from "./head-office-users-table"

/**
 * The Head Office user directory with its real search, pager, detail drawer,
 * status toggle, delete confirmation and edit dialog. Every write goes through
 * the API; what is asserted is which call each action makes and with what.
 */
function user(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    firstName: `First${index}`,
    lastName: `Last${index}`,
    fullName: `First${index} Last${index}`,
    email: `user${index}@example.test`,
    username: `user${index}`,
    role: index % 2 === 0 ? "BRANCH_ADMIN" : "ORDER_PORTAL",
    organizationId: 5,
    branchId: 11,
    isActive: true,
    mfaEnabled: false,
    createdAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  }
}

const USERS = Array.from({ length: 25 }, (_, index) => user(index + 1))
const BRANCHES = [{ id: 11, name: "North", organizationId: 5 }]
const ORGANIZATIONS = [{ id: 5, name: "Acme" }]

function routes() {
  installFetch([
    [/^\/api\/v1\/users\/[^/]+\/scope/, { item: { groups: [], branches: [], effectiveBranchIds: [] } }],
    [/^\/api\/v1\/users\/[^/]+\/access/, { success: true }],
    [/^\/api\/v1\/users\/check-username/, { available: true }],
    [/^\/api\/v1\/users\/[^/]+$/, { success: true }],
    ["/api/v1/groups", { groups: [] }],
    ["/api/v1/branches", { items: BRANCHES }],
  ])
}

function renderTable(onUserUpdate = vi.fn(), users = USERS) {
  renderWithApp(
    <HeadOfficeUsersTable users={users as any} branches={BRANCHES} organizations={ORGANIZATIONS} userRole="HEAD_OFFICE" onUserUpdate={onUserUpdate} />,
  )
  return onUserUpdate
}

beforeEach(() => {
  resetUi({ id: "ho-1", role: "HEAD_OFFICE", organizationId: 5 })
  routes()
  vi.stubGlobal("alert", vi.fn())
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "debug").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

describe("Head Office user directory", () => {
  it("shows Multiple for a user reaching several branches and lists them without opening the drawer", async () => {
    renderTable(vi.fn(), [
      user(1, {
        role: "GROUP_USER",
        branchId: null,
        assignedBranches: [{ id: 11, name: "North" }, { id: 12, name: "South" }],
      }),
      user(2, { role: "GROUP_ORDER_PORTAL", branchId: null, assignedBranches: [{ id: 12, name: "South" }] }),
      user(3, { role: "HEAD_OFFICE", branchId: null }),
    ])

    const multiple = screen.getByRole("button", { name: "Multiple: 2 branches" })
    // A group user is never labelled with the tenant-wide "Head Office".
    expect(screen.getAllByTitle("Head Office")).toHaveLength(1)
    expect(screen.getAllByTitle("South")).toHaveLength(1)

    fireEvent.click(multiple)
    expect(await screen.findByText("Assigned branches (2)")).toBeTruthy()
    expect(screen.getAllByText("North").length).toBeGreaterThan(0)
    expect(screen.queryByRole("button", { name: /Deactivate/ })).toBeNull()
  })

  it("opens the branch list on hover", async () => {
    renderTable(vi.fn(), [
      user(1, {
        role: "GROUP_USER",
        branchId: null,
        assignedBranches: [{ id: 11, name: "North" }, { id: 12, name: "South" }],
      }),
    ])
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Multiple: 2 branches" }))
    expect(await screen.findByText("Assigned branches (2)")).toBeTruthy()
  })

  it("shows twenty users a page and pages through the rest", async () => {
    renderTable()
    expect(screen.getAllByText("First1 Last1").length).toBeGreaterThan(0)
    expect(screen.queryAllByText("First21 Last21")).toHaveLength(0)

    const pagerButtons = screen.getAllByRole("button").filter((button) => button.textContent === "" && button.closest("div"))
    const next = pagerButtons.at(-1)!
    fireEvent.click(next)
    await waitFor(() => expect(screen.getAllByText("First21 Last21").length).toBeGreaterThan(0))
  })

  it("searches by name and email", async () => {
    renderTable()
    const search = screen.getByPlaceholderText("Search users by name or email...")
    fireEvent.change(search, { target: { value: "user7@" } })
    await waitFor(() => expect(screen.queryAllByText("First1 Last1")).toHaveLength(0))
    expect(screen.getAllByText("First7 Last7").length).toBeGreaterThan(0)

    fireEvent.change(search, { target: { value: "First13" } })
    await waitFor(() => expect(screen.getAllByText("First13 Last13").length).toBeGreaterThan(0))
  })

  it("deactivates a user from the detail drawer and reports the change", async () => {
    const onUserUpdate = renderTable()
    fireEvent.click(screen.getAllByText("First2 Last2")[0])
    fireEvent.click(await screen.findByRole("button", { name: /Deactivate/ }))

    await waitFor(() => expect(callsTo(/\/api\/v1\/users\/[^/]+\/access/, "PATCH")).toHaveLength(1))
    expect(callsTo(/\/access/, "PATCH")[0]).toMatchObject({ url: `/api/v1/users/${USERS[1].id}/access`, body: { isActive: false } })
    await waitFor(() => expect(onUserUpdate).toHaveBeenCalled())
  })

  it("rolls the drawer back and says so when the status change fails", async () => {
    installFetch([[/\/access/, { status: 500, body: { error: "boom" } }]])
    renderTable()
    fireEvent.click(screen.getAllByText("First2 Last2")[0])
    fireEvent.click(await screen.findByRole("button", { name: /Deactivate/ }))
    await waitFor(() => expect(window.alert).toHaveBeenCalled())
    expect(await screen.findByRole("button", { name: /Deactivate/ })).toBeTruthy()
  })

  it("deletes a user only after confirmation", async () => {
    const onUserUpdate = renderTable()
    fireEvent.click(screen.getAllByText("First3 Last3")[0])
    fireEvent.click(await screen.findByRole("button", { name: "Delete User" }))
    expect(callsTo(/^\/api\/v1\/users\/[^/]+$/, "DELETE")).toHaveLength(0)

    const dialog = await screen.findByRole("dialog", { name: /Delete User/ })
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete User" }))
    await waitFor(() => expect(callsTo(/^\/api\/v1\/users\/[^/]+$/, "DELETE")).toHaveLength(1))
    expect(callsTo(/^\/api\/v1\/users\/[^/]+$/, "DELETE")[0].url).toBe(`/api/v1/users/${USERS[2].id}`)
    await waitFor(() => expect(onUserUpdate).toHaveBeenCalled())
  })

  it("edits a profile and saves only through the API", async () => {
    const onUserUpdate = renderTable()
    fireEvent.click(screen.getAllByText("First4 Last4")[0])
    fireEvent.click(await screen.findByRole("button", { name: "Edit Profile" }))

    const firstName = await screen.findByPlaceholderText("Enter first name")
    fireEvent.change(firstName, { target: { value: "Renamed" } })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    await waitFor(() => expect(callsTo(/^\/api\/v1\/users\/[^/]+$/, "PATCH").length).toBeGreaterThan(0))
    const patch = callsTo(/^\/api\/v1\/users\/[^/]+$/, "PATCH")[0]
    expect(patch.url).toBe(`/api/v1/users/${USERS[3].id}`)
    expect(patch.body).toMatchObject({ firstName: "Renamed" })
    expect(patch.body).not.toHaveProperty("role")
    await waitFor(() => expect(onUserUpdate).toHaveBeenCalled())
  })

  it("shows the server's refusal against the field it concerns", async () => {
    installFetch([
      [/^\/api\/v1\/users\/[^/]+\/scope/, { item: { groups: [], branches: [], effectiveBranchIds: [] } }],
      [/^\/api\/v1\/users\/[^/]+$/, { status: 400, body: { error: "Email address already exists." } }],
      [/.*/, {}],
    ])
    renderTable()
    fireEvent.click(screen.getAllByText("First4 Last4")[0])
    fireEvent.click(await screen.findByRole("button", { name: "Edit Profile" }))
    fireEvent.change(await screen.findByPlaceholderText("Enter email address"), { target: { value: "user5@example.test" } })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))
    await waitFor(() => expect(document.body.textContent).toMatch(/already/i))
  })

  it("renders an empty directory", () => {
    renderTable(vi.fn(), [])
    expect(document.body.textContent?.length).toBeGreaterThan(0)
  })
})
