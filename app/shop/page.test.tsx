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

/** A signed-in Order Portal user browsing a one-product branch catalogue. */
function mockStockedShop(user: Record<string, unknown> = {}) {
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
        ...user,
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
}

describe("OrderPortalPage cart dialog", () => {
  beforeEach(() => {
    mockStockedShop()
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

describe("OrderPortalPage cart persistence", () => {
  const savedCartKey = "oneflowe.shop-cart.v1:7:2"

  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it("brings the cart back after a reload", async () => {
    localStorage.setItem(savedCartKey, JSON.stringify([{ id: 101, quantity: 2 }]))
    mockStockedShop({ id: "7" })

    render(<OrderPortalPage />)

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open Cart" })).toBeTruthy()
    })
  })

  it("saves the cart as items are added", async () => {
    mockStockedShop({ id: "7" })

    render(<OrderPortalPage />)
    fireEvent.click(screen.getByRole("button", { name: /Add .* to Cart/ }))

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(savedCartKey) || "null")).toEqual([
        { id: 101, quantity: 1 },
      ])
    })
  })

  it("clears the saved cart once its items are removed", async () => {
    localStorage.setItem(savedCartKey, JSON.stringify([{ id: 101, quantity: 2 }]))
    mockStockedShop({ id: "7" })

    render(<OrderPortalPage />)
    fireEvent.click(await screen.findByRole("button", { name: "Open Cart" }))
    fireEvent.click(screen.getByTitle("Remove"))

    await waitFor(() => {
      expect(localStorage.getItem(savedCartKey)).toBeNull()
    })
  })

  it("never restores another user's saved cart", async () => {
    localStorage.setItem(savedCartKey, JSON.stringify([{ id: 101, quantity: 2 }]))
    mockStockedShop({ id: "8" })

    render(<OrderPortalPage />)

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add .* to Cart/ })).toBeTruthy()
    })
    expect(screen.queryByRole("button", { name: "Open Cart" })).toBeNull()
    expect(localStorage.getItem(savedCartKey)).toBe(JSON.stringify([{ id: 101, quantity: 2 }]))
  })

  it("leaves a saved cart alone for a session with no user id", async () => {
    localStorage.setItem(savedCartKey, JSON.stringify([{ id: 101, quantity: 2 }]))
    mockStockedShop()

    render(<OrderPortalPage />)

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add .* to Cart/ })).toBeTruthy()
    })
    expect(localStorage.getItem(savedCartKey)).toBe(JSON.stringify([{ id: 101, quantity: 2 }]))
  })
})

/** A branch catalogue spanning two categories, one of which has two subcategories. */
function mockCategorisedShop(items: Record<string, unknown>[]) {
  mockStockedShop()
  const stockedSwr = mocks.useSWR.getMockImplementation()!
  mocks.useSWR.mockImplementation((url: string | null, ...rest: unknown[]) => {
    if (url?.startsWith("/api/v1/branch/inventory?")) {
      return { data: { items }, mutate: vi.fn() }
    }
    return (stockedSwr as (...args: unknown[]) => unknown)(url, ...rest)
  })
}

const CATALOGUE = [
  {
    organizationInventoryId: 201,
    productName: "Full cream milk",
    productCode: "MILK-1",
    basePrice: 1_000,
    unit: "item",
    stockQuantity: 10,
    categoryName: "Milk",
    parentCategoryName: "Grocery",
  },
  {
    organizationInventoryId: 202,
    productName: "Green tea bags",
    productCode: "TEA-1",
    basePrice: 1_000,
    unit: "item",
    stockQuantity: 10,
    categoryName: "Green Tea",
    parentCategoryName: "Grocery",
  },
  {
    organizationInventoryId: 203,
    productName: "AA batteries",
    productCode: "BATT-1",
    basePrice: 1_000,
    unit: "item",
    stockQuantity: 10,
    categoryName: "Batteries",
    parentCategoryName: "Electronics",
  },
]

const VIEW_DETAILS_PREFIX = "View details for "
/** Grid contents, in render order, read off each card's accessible label. */
const productNames = () => screen
  .getAllByRole("button", { name: new RegExp("^" + VIEW_DETAILS_PREFIX) })
  .map((node) => node.getAttribute("aria-label")!.slice(VIEW_DETAILS_PREFIX.length))

/** Subcategory chips, which sit alongside the picker. */
const ribbonChips = () => Array.from(
  document.querySelectorAll<HTMLElement>("[data-testid='shop-category-ribbon'] button"),
).map((node) => node.textContent)

const categoryTrigger = () => screen.getByRole("combobox", { name: "Filter by category" })

/** Radix's popover and cmdk's list need browser APIs jsdom does not implement. */
function installPopoverPolyfills() {
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.scrollIntoView ??= vi.fn()
  proto.hasPointerCapture ??= vi.fn(() => false)
  proto.setPointerCapture ??= vi.fn()
  proto.releasePointerCapture ??= vi.fn()
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

async function openCategoryPicker() {
  fireEvent.click(categoryTrigger())
  await screen.findByRole("option", { name: /All Categories/ })
}

async function chooseCategoryOption(name: RegExp | string) {
  await openCategoryPicker()
  fireEvent.click(screen.getByRole("option", { name }))
  await waitFor(() => {
    expect(screen.queryByRole("option", { name: /All Categories/ })).toBeNull()
  })
}

describe("OrderPortalPage category filter", () => {
  beforeEach(() => {
    installPopoverPolyfills()
  })

  afterEach(() => {
    cleanup()
  })

  it("shows every product until a category is chosen", () => {
    mockCategorisedShop(CATALOGUE)
    render(<OrderPortalPage />)

    expect(categoryTrigger().textContent).toContain("All Categories")
    expect(productNames()).toEqual(["AA batteries", "Full cream milk", "Green tea bags"])
  })

  it("groups the branch's own subcategories under their parent category", async () => {
    mockCategorisedShop(CATALOGUE)
    render(<OrderPortalPage />)

    await openCategoryPicker()

    expect(screen.getByRole("option", { name: /All of Electronics/ })).toBeTruthy()
    expect(screen.getByRole("option", { name: /All of Grocery/ })).toBeTruthy()
    expect(screen.getByRole("option", { name: "Milk" })).toBeTruthy()
    expect(screen.getByRole("option", { name: "Batteries" })).toBeTruthy()
  })

  it("narrows the grid to a whole category", async () => {
    mockCategorisedShop(CATALOGUE)
    render(<OrderPortalPage />)

    await chooseCategoryOption(/All of Grocery/)

    expect(productNames()).toEqual(["Full cream milk", "Green tea bags"])
    expect(categoryTrigger().textContent).toContain("Grocery")
  })

  it("narrows the grid to a single subcategory", async () => {
    mockCategorisedShop(CATALOGUE)
    render(<OrderPortalPage />)

    await chooseCategoryOption("Milk")

    expect(productNames()).toEqual(["Full cream milk"])
    expect(categoryTrigger().textContent).toContain("Milk")
  })

  it("scopes the subcategory ribbon to the chosen category", async () => {
    mockCategorisedShop(CATALOGUE)
    render(<OrderPortalPage />)

    expect(ribbonChips()).toEqual(["All", "Batteries", "Green Tea", "Milk"])

    await chooseCategoryOption(/All of Grocery/)

    expect(ribbonChips()).toEqual(["All", "Green Tea", "Milk"])
  })

  it("drops a subcategory that the newly chosen category does not contain", async () => {
    mockCategorisedShop(CATALOGUE)
    render(<OrderPortalPage />)

    await chooseCategoryOption("Milk")
    expect(productNames()).toEqual(["Full cream milk"])

    await chooseCategoryOption(/All of Electronics/)

    await waitFor(() => {
      expect(productNames()).toEqual(["AA batteries"])
    })
    expect(categoryTrigger().textContent).toContain("Electronics")
  })

  it("keeps the picker in step when a ribbon chip is used", async () => {
    mockCategorisedShop(CATALOGUE)
    render(<OrderPortalPage />)

    fireEvent.click(screen.getByRole("button", { name: "Batteries" }))

    await waitFor(() => {
      expect(productNames()).toEqual(["AA batteries"])
    })
    expect(categoryTrigger().textContent).toContain("Batteries")
    expect(categoryTrigger().textContent).toContain("in Electronics")
  })

  it("clears the filter from the active-filter chip", async () => {
    mockCategorisedShop(CATALOGUE)
    render(<OrderPortalPage />)

    await chooseCategoryOption(/All of Grocery/)
    expect(productNames()).toHaveLength(2)

    fireEvent.click(screen.getByRole("button", { name: "Clear category filter Grocery" }))

    await waitFor(() => {
      expect(productNames()).toEqual(["AA batteries", "Full cream milk", "Green tea bags"])
    })
  })

  it("treats a product hung straight off a top-level category as its own group", async () => {
    mockCategorisedShop([
      ...CATALOGUE,
      {
        organizationInventoryId: 204,
        productName: "Loose stationery",
        productCode: "STAT-1",
        basePrice: 1_000,
        unit: "item",
        stockQuantity: 10,
        categoryName: "Stationery",
        parentCategoryName: null,
      },
    ])
    render(<OrderPortalPage />)

    await chooseCategoryOption(/All of Stationery/)

    expect(productNames()).toEqual(["Loose stationery"])
  })

  it("leaves uncategorised products out of every category but visible under All", async () => {
    mockCategorisedShop([
      ...CATALOGUE,
      {
        organizationInventoryId: 205,
        productName: "Unfiled item",
        productCode: "MISC-1",
        basePrice: 1_000,
        unit: "item",
        stockQuantity: 10,
        categoryName: null,
        parentCategoryName: null,
      },
    ])
    render(<OrderPortalPage />)

    expect(productNames()).toContain("Unfiled item")

    await chooseCategoryOption(/All of Grocery/)

    expect(productNames()).toEqual(["Full cream milk", "Green tea bags"])
  })

  it("still searches within the chosen category", async () => {
    mockCategorisedShop(CATALOGUE)
    render(<OrderPortalPage />)

    await chooseCategoryOption(/All of Grocery/)
    fireEvent.change(screen.getByPlaceholderText("Search products by name or code..."), {
      target: { value: "TEA-1" },
    })

    expect(productNames()).toEqual(["Green tea bags"])
  })

  it("clears the search from its inline button", async () => {
    mockCategorisedShop(CATALOGUE)
    render(<OrderPortalPage />)

    const search = screen.getByPlaceholderText("Search products by name or code...")
    fireEvent.change(search, { target: { value: "TEA-1" } })
    expect(productNames()).toEqual(["Green tea bags"])

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }))

    await waitFor(() => {
      expect(productNames()).toHaveLength(3)
    })
  })
})
