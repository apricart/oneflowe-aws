import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  useSWR: vi.fn(),
  useSession: vi.fn(),
  signOut: vi.fn(),
  useRouter: vi.fn(),
  useToast: vi.fn(),
  useAppContext: vi.fn(),
  useOrganizations: vi.fn(),
  useBranches: vi.fn(),
}))

vi.mock("swr", () => ({ default: mocks.useSWR }))
vi.mock("next-auth/react", () => ({
  useSession: mocks.useSession,
  signOut: mocks.signOut,
}))
vi.mock("next/navigation", () => ({ useRouter: mocks.useRouter }))
vi.mock("@/hooks/use-toast", () => ({ useToast: mocks.useToast }))
vi.mock("@/components/context/app-context", () => ({
  useAppContext: mocks.useAppContext,
}))
vi.mock("@/lib/hooks/use-api", () => ({
  useOrganizations: mocks.useOrganizations,
  useBranches: mocks.useBranches,
}))
vi.mock("@/components/shell/session-guard", () => ({
  MANUAL_SIGN_OUT_EVENT: "oneflowe:manual-sign-out",
}))
vi.mock("@/components/shell/context-selector", () => ({
  ContextSelector: () => null,
}))
vi.mock("@/components/refund-management", () => ({
  RefundManagement: () => null,
}))
vi.mock("@/components/receipts/receipt-icon-button", () => ({
  ReceiptIconButton: () => null,
}))
vi.mock("@/components/notifications/notification-center", () => ({
  NotificationBell: () => null,
}))

import OrderPortalPage from "@/app/shop/page"

describe("OrderPortalPage data refresh policy", () => {
  beforeEach(() => {
    mocks.useSWR.mockReset().mockReturnValue({})
    mocks.useSession.mockReset().mockReturnValue({
      data: {
        user: {
          role: "ORDER_PORTAL",
          organizationId: 1,
          branchId: 2,
        },
      },
      status: "loading",
    })
    mocks.signOut.mockReset()
    mocks.useRouter.mockReset().mockReturnValue({})
    mocks.useToast.mockReset().mockReturnValue({ toast: vi.fn() })
    mocks.useAppContext.mockReset().mockReturnValue({
      branchId: null,
      organizationId: null,
    })
    mocks.useOrganizations.mockReset().mockReturnValue({})
    mocks.useBranches.mockReset().mockReturnValue({})
  })

  afterEach(() => {
    cleanup()
  })

  it("does not poll inventory or budgets while the Shop view is idle", () => {
    render(<OrderPortalPage />)

    expect(mocks.useSWR).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/api/v1/branch/inventory?"),
      expect.any(Function),
      expect.objectContaining({
        refreshInterval: 0,
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
      }),
    )
    expect(mocks.useSWR).toHaveBeenNthCalledWith(
      2,
      "/api/v1/budgets?branchId=2&organizationId=1",
      expect.any(Function),
      expect.objectContaining({
        refreshInterval: 0,
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
      }),
    )
  })
})

describe("OrderPortalPage cart dialog", () => {
  beforeEach(() => {
    mocks.useSWR.mockReset().mockImplementation((url: string | null) => {
      if (url?.startsWith("/api/v1/branch/inventory?")) {
        return {
          data: {
            items: [{
              organizationInventoryId: 101,
              productName: "Test product",
              productCode: "TEST-101",
              basePrice: 1_000,
              unit: "item",
              stockQuantity: 10,
            }],
          },
          mutate: vi.fn(),
        }
      }
      if (url?.startsWith("/api/v1/budgets")) {
        return {
          data: {
            remainingCents: 10_000,
            amountAllocatedCents: 10_000,
            amountCreditedCents: 0,
          },
          mutate: vi.fn(),
        }
      }
      return {
        data: { items: [] },
        mutate: vi.fn(),
      }
    })
    mocks.useSession.mockReset().mockReturnValue({
      data: {
        user: {
          role: "ORDER_PORTAL",
          organizationId: 1,
          branchId: 2,
        },
      },
      status: "authenticated",
    })
    mocks.signOut.mockReset()
    mocks.useRouter.mockReset().mockReturnValue({})
    mocks.useToast.mockReset().mockReturnValue({ toast: vi.fn() })
    mocks.useAppContext.mockReset().mockReturnValue({
      branchId: null,
      organizationId: null,
    })
    mocks.useOrganizations.mockReset().mockReturnValue({
      data: { items: [{ id: 1, name: "Test organization" }] },
    })
    mocks.useBranches.mockReset().mockReturnValue({
      data: { items: [{ id: 2, name: "Test branch" }] },
    })
  })

  afterEach(() => {
    cleanup()
  })

  it("closes the dialog and removes its open overlay when the last item is removed", async () => {
    render(<OrderPortalPage />)

    fireEvent.click(screen.getByRole("button", { name: /Add .* to Cart/ }))
    fireEvent.click(screen.getByRole("button", { name: "Open Cart" }))

    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(document.querySelector('[data-slot="dialog-overlay"][data-state="open"]')).toBeTruthy()

    fireEvent.click(screen.getByTitle("Remove"))

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(document.querySelector('[data-slot="dialog-overlay"][data-state="open"]')).toBeNull()
    })
  })
})
