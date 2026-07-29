import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  mutateOrganizations: vi.fn(),
  mutateBranches: vi.fn(),
}))

vi.mock("@/lib/hooks/use-api", () => ({
  useOrganizations: () => ({
    data: {
      items: [
        { id: 1, name: "Zomato", code: "0001", status: "active", budgetAllocationMode: "money" },
        { id: 2, name: "Panacloud", code: "0002", status: "active", budgetAllocationMode: "money" },
      ],
    },
    mutate: mocks.mutateOrganizations,
    isLoading: false,
  }),
  useBranches: () => ({
    data: {
      items: [
        { id: 11, name: "Zomato Branch", code: "ZB", organizationId: 1, status: "active" },
        { id: 22, name: "Panacloud Branch", code: "PB", organizationId: 2, status: "active" },
      ],
    },
    mutate: mocks.mutateBranches,
  }),
}))

vi.mock("@/components/context/app-context", () => ({
  useAppContext: () => ({ organizationId: "1" }),
}))

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { role: "SUPER_ADMIN" } } }),
}))

import OrganizationsPage from "./page"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("OrganizationsPage organization selection", () => {
  it("keeps a clicked organization selected when a global organization context exists", () => {
    render(<OrganizationsPage />)

    const panacloudItem = screen.getByText("Panacloud").closest('[role="button"]')
    expect(panacloudItem).not.toBeNull()
    expect(panacloudItem?.className).toContain("border-transparent")

    fireEvent.click(panacloudItem!)

    expect(panacloudItem?.className).toContain("border-indigo-500/30")
    expect(screen.getAllByText("Panacloud")).toHaveLength(2)
    expect(screen.getByText("Panacloud Branch")).toBeTruthy()
  })
})
