import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GroupUserDashboard } from "./group-user-dashboard"

const mocks = vi.hoisted(() => ({
  context: {
    organizationId: 41 as number | null,
    isInitialized: true,
  },
  swr: vi.fn(),
  dashboard: vi.fn(),
}))

vi.mock("swr", () => ({ default: mocks.swr }))
vi.mock("@/components/context/app-context", () => ({
  useAppContext: () => mocks.context,
}))
vi.mock("@/components/dashboard/dashboard-skeleton", () => ({
  DashboardSkeleton: () => <div data-testid="dashboard-skeleton">Loading dashboard</div>,
}))
vi.mock("@/components/dashboard/branch-admin-dashboard", () => ({
  BranchAdminDashboard: (props: unknown) => {
    mocks.dashboard(props)
    return <div data-testid="branch-dashboard">Branch dashboard</div>
  },
}))

describe("GroupUserDashboard", () => {
  beforeEach(() => {
    mocks.context.organizationId = 41
    mocks.context.isInitialized = true
    mocks.swr.mockReset()
    mocks.dashboard.mockReset()
  })

  afterEach(cleanup)

  it("does not request or render metrics before the authenticated shell context is ready", () => {
    mocks.context.isInitialized = false
    mocks.swr.mockReturnValue({ data: undefined, isLoading: false })

    render(<GroupUserDashboard />)

    expect(mocks.swr).toHaveBeenCalledWith(null, expect.any(Function))
    expect(screen.getByTestId("dashboard-skeleton")).toBeTruthy()
    expect(mocks.dashboard).not.toHaveBeenCalled()
  })

  it("shows a safe empty state instead of widening an account with no assignments to its tenant", () => {
    mocks.swr.mockReturnValue({
      data: { item: { branches: [] } },
      isLoading: false,
    })

    render(<GroupUserDashboard />)

    expect(mocks.swr).toHaveBeenCalledWith(
      "/api/v1/group-portal/scope",
      expect.any(Function),
    )
    expect(screen.getByRole("heading", { name: "No branches assigned" })).toBeTruthy()
    expect(screen.getByText(/nothing to report on/i)).toBeTruthy()
    expect(mocks.dashboard).not.toHaveBeenCalled()
  })

  it("passes exactly the server-resolved branch set into the shared dashboard", () => {
    mocks.swr.mockReturnValue({
      data: { item: { branches: [{ id: 19 }, { id: 7 }] } },
      isLoading: false,
    })

    render(<GroupUserDashboard />)

    expect(screen.getByTestId("branch-dashboard")).toBeTruthy()
    expect(mocks.dashboard).toHaveBeenCalledOnce()
    expect(mocks.dashboard).toHaveBeenCalledWith({
      scope: {
        organizationId: 41,
        branchId: null,
        branchIds: ["19", "7"],
        isReady: true,
        heading: "Branch Metrics",
      },
    })
  })

  it("keeps the loading screen up while the assignment endpoint is unresolved", () => {
    mocks.swr.mockReturnValue({ data: undefined, isLoading: true })

    render(<GroupUserDashboard />)

    expect(screen.getByTestId("dashboard-skeleton")).toBeTruthy()
    expect(mocks.dashboard).not.toHaveBeenCalled()
  })
})
