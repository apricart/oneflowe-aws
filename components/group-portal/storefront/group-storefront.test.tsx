import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GroupStorefront } from "./group-storefront"

const mocks = vi.hoisted(() => ({
  swr: vi.fn(),
  sidebar: vi.fn(),
  catalog: vi.fn(),
  header: vi.fn(),
  mutateBudgets: vi.fn(async () => {}),
}))

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { name: "Ayesha" } } }),
}))
vi.mock("swr", () => ({ default: mocks.swr }))
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock("./use-storefront-draft", () => ({
  useStorefrontDraft: () => ({
    status: "ready",
    saveState: "saved",
    restoreFailed: false,
    retrying: false,
    retryDraftRestore: vi.fn(),
    forgetDraft: vi.fn(),
  }),
}))
vi.mock("./group-sidebar", () => ({
  groupKey: (id: number | null) => String(id ?? "ungrouped"),
  GroupSidebar: (props: unknown) => {
    mocks.sidebar(props)
    return <div data-testid="group-sidebar">Assigned locations</div>
  },
}))
vi.mock("./storefront-catalog", () => ({
  StorefrontCatalog: (props: unknown) => {
    mocks.catalog(props)
    return <div data-testid="storefront-catalog">Scoped catalogue</div>
  },
}))
vi.mock("./storefront-header", () => ({
  StorefrontHeader: (props: unknown) => {
    mocks.header(props)
    return <div data-testid="storefront-header">Group Order Portal</div>
  },
}))
vi.mock("./storefront-cart", () => ({ StorefrontCart: () => null }))
vi.mock("../group-order-history", () => ({
  GroupOrderHistory: () => <div data-testid="group-order-history">My submitted group orders</div>,
}))
vi.mock("../group-refund-history", () => ({
  GroupRefundHistory: () => <div data-testid="group-refund-history">My refunds</div>,
}))
vi.mock("../other-branch-orders", () => ({
  OtherBranchOrders: () => <div data-testid="other-branch-orders">Other branch orders</div>,
}))
vi.mock("../review-step", () => ({ ReviewStep: () => null }))
vi.mock("../submission-result", () => ({ SubmissionResult: () => null }))
vi.mock("@/components/ui/confirm-dialog", () => ({ ConfirmDialog: () => null }))
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe("GroupStorefront", () => {
  beforeEach(() => {
    mocks.swr.mockReset()
    mocks.sidebar.mockReset()
    mocks.catalog.mockReset()
    mocks.header.mockReset()
    mocks.mutateBudgets.mockReset()
    mocks.swr.mockImplementation((key: string) => {
      if (key === "/api/v1/group-portal/groups") {
        return {
          data: {
            items: [{
              id: 5,
              name: "North Region",
              branches: [
                { id: 11, name: "Islamabad", city: "Islamabad", costCenterId: "CC-11", groupId: 5 },
                { id: 12, name: "Rawalpindi", city: "Rawalpindi", costCenterId: "CC-12", groupId: 5 },
              ],
            }],
            autoSelectGroupId: 5,
          },
          error: undefined,
          isLoading: false,
        }
      }
      if (key === "/api/v1/group-portal/scope") {
        return { data: { item: { organization: { id: 2, name: "Acme" } } } }
      }
      if (key === "/api/v1/group-portal/budgets") {
        return {
          data: { items: [], period: "2026-09" },
          isLoading: false,
          mutate: mocks.mutateBudgets,
        }
      }
      throw new Error(`Unexpected SWR key: ${key}`)
    })
  })

  afterEach(cleanup)

  it("loads only the three role-scoped resources and auto-selects every location in a sole group", async () => {
    render(<GroupStorefront />)

    expect([...new Set(mocks.swr.mock.calls.map(([key]) => key))]).toEqual([
      "/api/v1/group-portal/groups",
      "/api/v1/group-portal/scope",
      "/api/v1/group-portal/budgets",
    ])

    await waitFor(() => {
      expect(mocks.catalog).toHaveBeenLastCalledWith(expect.objectContaining({
        groupId: 5,
        branchIds: [11, 12],
        lines: [],
      }))
    })
    expect(mocks.header).toHaveBeenLastCalledWith(expect.objectContaining({
      userName: "Ayesha",
      organizationName: "Acme",
      groupName: "North Region",
      locationCount: 2,
      cartCount: 0,
      combinedCents: 0,
    }))
    expect(mocks.sidebar).toHaveBeenLastCalledWith(expect.objectContaining({
      selectedGroupId: 5,
      selectedBranchIds: [11, 12],
      disabled: false,
    }))
  })

  it("keeps the requester's shop, own submissions, other orders, and refunds separate", () => {
    render(<GroupStorefront />)

    expect(screen.getByTestId("storefront-catalog")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "My group orders" }))
    expect(screen.getByTestId("group-order-history")).toBeTruthy()
    expect(screen.queryByTestId("storefront-catalog")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Other orders" }))
    expect(screen.getByTestId("other-branch-orders")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Refunds" }))
    expect(screen.getByTestId("group-refund-history")).toBeTruthy()
  })
})
