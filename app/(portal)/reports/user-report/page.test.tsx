import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const session = vi.hoisted(() => ({ role: "HEAD_OFFICE" }))
const mutate = vi.hoisted(() => vi.fn())
const swrResponse = vi.hoisted(() => ({
  data: {
    data: [],
    trend: [],
    compareTrend: [],
    years: [2026],
    pricesHidden: false,
  },
  isLoading: false,
  mutate,
}))

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: { user: { role: session.role, organizationId: 11 } },
  }),
}))

vi.mock("swr", () => ({ default: () => swrResponse }))

vi.mock("@/components/context/app-context", () => ({
  useAppContext: () => ({ organizationId: 11, branchIds: ["12"], isInitialized: true }),
}))

vi.mock("@/components/dashboard/global-date-filter", () => ({ GlobalDateFilter: () => null }))
vi.mock("@/components/reports/branch-filter", () => ({ BranchFilter: () => null }))
vi.mock("@/components/reports/group-filter", () => ({ GroupFilter: () => null }))
vi.mock("@/components/reports/kpi-card", () => ({ KPICard: () => null }))
vi.mock("@/components/reports/multi-select-filter", () => ({ MultiSelectFilter: () => null }))
vi.mock("@/components/reports/organization-filter", () => ({ OrganizationFilter: () => null }))
vi.mock("@/components/reports/user-filter", () => ({ UserFilter: () => null }))
vi.mock("@/components/reports/users-to-review-tab", () => ({
  UsersToReviewTab: ({ role, organizationId, branchIds }: {
    role: string
    organizationId: number
    branchIds: string[]
  }) => <div data-testid="users-to-review-content">{role}:{organizationId}:{branchIds.join(",")}</div>,
}))

vi.mock("recharts", () => ({
  ResponsiveContainer: () => null,
  ComposedChart: () => null,
  Bar: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  Line: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}))

import UserReportPage from "./page"

beforeEach(() => {
  session.role = "HEAD_OFFICE"
  mutate.mockClear()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

describe("User Report tabs", () => {
  it.each(["HEAD_OFFICE", "SUPER_ADMIN"])(
    "places Users to review beside Reports for %s and carries the page scope into it",
    (role) => {
      session.role = role
      render(<UserReportPage />)

      const tabs = screen.getAllByRole("tab")
      expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(["Analytics", "Reports", "Users to review"])

      fireEvent.mouseDown(screen.getByRole("tab", { name: "Users to review" }), { button: 0, ctrlKey: false })
      expect(screen.getByTestId("users-to-review-content").textContent).toBe(`${role}:11:12`)
    },
  )

  it.each(["GROUP_USER", "BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_ORDER_PORTAL"])(
    "does not offer the protected watchlist to %s",
    (role) => {
      session.role = role
      render(<UserReportPage />)

      expect(screen.queryByRole("tab", { name: "Users to review" })).toBeNull()
      expect(screen.queryByTestId("users-to-review-content")).toBeNull()
    },
  )
})
