import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  context: {
    organizationId: null as string | null,
    branchId: null as string | null,
    branchIds: [] as string[],
    userRole: null as "SUPER_ADMIN" | "HEAD_OFFICE" | "BRANCH_ADMIN" | null,
    isInitialized: false,
  },
  usersData: undefined as { items: any[] } | undefined,
  usersError: undefined as Error | undefined,
  usersLoading: true,
  mutateUsers: vi.fn(),
  swrKeys: [] as Array<string | null>,
}))

vi.mock("@/components/context/app-context", () => ({
  useAppContext: () => mocks.context,
}))

vi.mock("swr", () => ({
  default: (key: string | null) => {
    mocks.swrKeys.push(key)

    if (key === "/api/v1/users") {
      return {
        data: mocks.usersData,
        error: mocks.usersError,
        isLoading: mocks.usersLoading,
        mutate: mocks.mutateUsers,
      }
    }

    if (key === null) {
      return {
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
      }
    }

    return {
      data: { items: [] },
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    }
  },
}))

vi.mock("@/components/users/create-user-dialog", () => ({
  CreateUserDialog: () => <button type="button">Create User</button>,
}))

vi.mock("@/components/users/head-office-users-table", () => ({
  HeadOfficeUsersTable: ({
    users,
    userRole,
  }: {
    users: Array<{ id: string }>
    userRole?: string
  }) => (
    <div data-testid="users-table" data-user-role={userRole}>
      <span data-testid="rendered-user-ids">{users.map((user) => user.id).join(",")}</span>
      {users.length === 0 ? <span>No users found.</span> : <span>{users.length} users</span>}
    </div>
  ),
}))

import UsersPage from "@/app/(portal)/users/page"

const users = [
  { id: "org-1-ho", organizationId: 1, branchId: null, role: "HEAD_OFFICE" },
  { id: "org-1-admin", organizationId: 1, branchId: 11, role: "BRANCH_ADMIN" },
  { id: "org-1-order", organizationId: 1, branchId: 11, role: "ORDER_PORTAL" },
  { id: "org-2-ho", organizationId: 2, branchId: null, role: "HEAD_OFFICE" },
  { id: "org-2-admin", organizationId: 2, branchId: 22, role: "BRANCH_ADMIN" },
  { id: "org-2-order", organizationId: 2, branchId: 22, role: "ORDER_PORTAL" },
]

function expectTotalUsers(expected: string) {
  const label = screen.getByText("Total Users")
  const value = label.parentElement?.querySelector("p:nth-of-type(2)")?.textContent
  expect(value).toBe(expected)
}

describe("UsersPage readiness and scoping", () => {
  beforeEach(() => {
    mocks.context = {
      organizationId: null,
      branchId: null,
      branchIds: [],
      userRole: null,
      isInitialized: false,
    }
    mocks.usersData = undefined
    mocks.usersError = undefined
    mocks.usersLoading = true
    mocks.mutateUsers.mockReset()
    mocks.swrKeys = []
  })

  afterEach(() => {
    cleanup()
  })

  it("does not show a false empty state when users arrive before client context hydration", () => {
    mocks.usersData = { items: users }
    mocks.usersLoading = false

    const { rerender } = render(<UsersPage />)

    expect(screen.getByRole("status").textContent).toContain("Loading users...")
    expect(screen.queryByText("No users found.")).toBeNull()
    expect(screen.queryByText("Total Users")).toBeNull()
    expect(mocks.swrKeys).not.toContain("/api/v1/users")

    mocks.context = {
      organizationId: null,
      branchId: null,
      branchIds: [],
      userRole: "SUPER_ADMIN",
      isInitialized: true,
    }
    rerender(<UsersPage />)

    expectTotalUsers("6")
    expect(screen.getByTestId("rendered-user-ids").textContent).toBe(
      users.map((user) => user.id).join(","),
    )
    expect(mocks.swrKeys).toContain("/api/v1/users")
    expect(mocks.mutateUsers).not.toHaveBeenCalled()
  })

  it("shows the real empty state only after context and a valid empty response are ready", () => {
    mocks.context = {
      organizationId: null,
      branchId: null,
      branchIds: [],
      userRole: "SUPER_ADMIN",
      isInitialized: true,
    }
    mocks.usersData = { items: [] }
    mocks.usersLoading = false

    render(<UsersPage />)

    expectTotalUsers("0")
    expect(screen.getByText("No users found.")).not.toBeNull()
    expect(screen.queryByText("Loading users...")).toBeNull()
  })

  it("keeps Super Admin organization and branch filters and Head Office tenant isolation unchanged", () => {
    mocks.context = {
      organizationId: null,
      branchId: null,
      branchIds: [],
      userRole: "SUPER_ADMIN",
      isInitialized: true,
    }
    mocks.usersData = { items: users }
    mocks.usersLoading = false

    const { rerender } = render(<UsersPage />)

    expect(screen.getByTestId("rendered-user-ids").textContent).toBe(
      users.map((user) => user.id).join(","),
    )

    mocks.context = {
      ...mocks.context,
      organizationId: "1",
    }
    rerender(<UsersPage />)

    expect(screen.getByTestId("rendered-user-ids").textContent).toBe(
      "org-1-ho,org-1-admin,org-1-order",
    )

    mocks.context = {
      ...mocks.context,
      branchIds: ["11"],
    }
    rerender(<UsersPage />)

    expect(screen.getByTestId("rendered-user-ids").textContent).toBe(
      "org-1-admin,org-1-order",
    )

    mocks.context = {
      organizationId: "2",
      branchId: null,
      branchIds: [],
      userRole: "HEAD_OFFICE",
      isInitialized: true,
    }
    rerender(<UsersPage />)

    expect(screen.getByTestId("rendered-user-ids").textContent).toBe(
      "org-2-ho,org-2-admin,org-2-order",
    )
  })

  it("shows a retryable error instead of an empty tenant when the initial request fails", () => {
    mocks.context = {
      organizationId: null,
      branchId: null,
      branchIds: [],
      userRole: "SUPER_ADMIN",
      isInitialized: true,
    }
    mocks.usersError = new Error("network unavailable")
    mocks.usersLoading = false

    render(<UsersPage />)

    expect(screen.getByRole("alert").textContent).toContain("Unable to load users")
    expect(screen.queryByText("No users found.")).toBeNull()
    expect(screen.queryByText("Total Users")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(mocks.mutateUsers).toHaveBeenCalledTimes(1)
  })
})
