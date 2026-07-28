import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("swr", () => ({
  default: (key: string | null) => {
    if (key === "/api/v1/organizations") {
      return {
        data: {
          items: [{ id: 12, name: "Zoomato", status: "active" }],
        },
        isLoading: false,
      }
    }

    if (key === "/api/v1/branches?organizationId=12") {
      return {
        data: { items: [] },
        isLoading: false,
      }
    }

    if (key === "/api/v1/branches/34") {
      return {
        data: {
          item: {
            id: 34,
            organizationId: 12,
            name: "Airport Branch",
            status: "active",
          },
        },
        isLoading: false,
      }
    }

    return { data: undefined, isLoading: false }
  },
}))

vi.mock("@/components/context/app-context", () => ({
  useAppContext: () => ({
    organizationId: null,
    branchId: null,
    branchIds: [],
    userRole: "BRANCH_ADMIN",
    userOrgId: 12,
    userBranchId: 34,
    setOrganizationId: vi.fn(),
    setBranchId: vi.fn(),
    resetContext: vi.fn(),
    isInitialized: true,
  }),
}))

import { ContextSelector } from "@/components/shell/context-selector"

describe("ContextSelector", () => {
  afterEach(() => {
    cleanup()
  })

  it("shows a Branch Admin's assigned scope after client context is reset", () => {
    render(<ContextSelector />)

    expect(screen.getByText("Zoomato")).not.toBeNull()
    expect(screen.getByText("Airport Branch")).not.toBeNull()
    expect(screen.queryByText("Global Overview")).toBeNull()
  })
})
