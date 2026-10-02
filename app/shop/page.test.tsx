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

  it("asks for the whole branch catalogue, not the endpoint's default page", () => {
    // The grid searches, sorts and filters on the client, so a page of 50
    // would leave every product past it invisible to the buyer.
    render(<OrderPortalPage />)

    const inventoryUrl = mocks.useSWR.mock.calls
      .map(([key]) => key)
      .find((key): key is string => typeof key === "string" && key.startsWith("/api/v1/branch/inventory?"))
    expect(inventoryUrl).toBeDefined()

    const params = new URL(inventoryUrl as string, "http://localhost").searchParams
    expect(params.get("limit")).toBe("1000")
    expect(params.get("visibility")).toBe("visible")
    expect(params.get("includeQuantityBudget")).toBe("true")
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

describe("OrderPortalPage unpaid-invoice ordering block", () => {
  const BLOCKED_MESSAGE = "You have 2 unpaid invoices. Please pay your dues before placing a new order."
  const blockedView = { orderingAllowed: false, overdueCount: 2, threshold: 2, reason: "THRESHOLD_REACHED" }
  const clearView = { orderingAllowed: true, overdueCount: 0, threshold: 2, reason: "NO_OVERDUE_PAYMENTS" }
  const reply = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

  /** Answers the pre-check, the pending-invoice check and the order POST. */
  function stubFetch(answers: { paymentControl: () => Response; order?: () => Response }) {
    const calls: Array<{ url: string; method: string }> = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      calls.push({ url, method })
      if (url.startsWith("/api/v1/payment-control")) return answers.paymentControl()
      if (url === "/api/v1/orders/pending-invoice") return reply(200, { hasPendingInvoice: false, pendingInvoice: null })
      if (url === "/api/v1/orders" && method === "POST") {
        return answers.order ? answers.order() : reply(200, { order: { tid: "TID-1" } })
      }
      return reply(200, {})
    }))
    return calls
  }

  async function placeOrder() {
    render(<OrderPortalPage />)
    fireEvent.click(screen.getByRole("button", { name: /Add .* to Cart/ }))
    fireEvent.click(screen.getByRole("button", { name: "Open Cart" }))
    fireEvent.click(screen.getByRole("button", { name: /Proceed to checkout/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Place Order" }))
  }

  beforeEach(() => {
    localStorage.clear()
    mockStockedShop()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it("shows the popup and submits nothing when the branch is blocked", async () => {
    const calls = stubFetch({ paymentControl: () => reply(200, blockedView) })
    await placeOrder()

    const popup = await screen.findByRole("alertdialog", { name: "Unpaid invoices" })
    expect(popup.textContent).toContain(BLOCKED_MESSAGE)
    // The Order Portal user asks for its own branch; the server resolves it.
    expect(calls.some((call) => call.url === "/api/v1/payment-control")).toBe(true)
    expect(calls.some((call) => call.url === "/api/v1/orders/pending-invoice")).toBe(false)
    expect(calls.some((call) => call.url === "/api/v1/orders" && call.method === "POST")).toBe(false)
  })

  it("places the order when the branch is clear", async () => {
    const calls = stubFetch({ paymentControl: () => reply(200, clearView) })
    await placeOrder()

    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/orders" && call.method === "POST")).toBe(true)
    })
    expect(screen.queryByRole("alertdialog", { name: "Unpaid invoices" })).toBeNull()
  })

  it("shows the same popup when the server refuses the order, instead of a generic error", async () => {
    // The pre-check failed, so it let the order through; the server's gate is the control.
    stubFetch({
      paymentControl: () => reply(500, { error: "Unable to load payment control" }),
      order: () => reply(409, {
        error: BLOCKED_MESSAGE,
        code: "PAYMENT_CONTROL_BLOCKED",
        paymentControl: { code: "PAYMENT_CONTROL_BLOCKED", state: "BLOCKED", reason: "THRESHOLD_REACHED", overdueCount: 2, threshold: 2, exceptionExpiredAt: null },
      }),
    })
    const toast = vi.fn()
    mocks.useToast.mockReturnValue({ toast })
    await placeOrder()

    const popup = await screen.findByRole("alertdialog", { name: "Unpaid invoices" })
    expect(popup.textContent).toContain(BLOCKED_MESSAGE)
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Failed" }))
  })

  it("closes the popup on OK", async () => {
    stubFetch({ paymentControl: () => reply(200, blockedView) })
    await placeOrder()

    fireEvent.click(await screen.findByRole("button", { name: "OK" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Unpaid invoices" })).toBeNull())
  })
})

describe("OrderPortalPage unacknowledged-delivery ordering block", () => {
  const TITLE = "Delivered orders awaiting acknowledgement"
  const BLOCKED_MESSAGE = "Your branch has 2 delivered orders awaiting acknowledgement. Please acknowledge/fulfil your delivered orders to place a new order."
  const blockedView = { branchId: 7, enabled: true, orderingAllowed: false, unacknowledgedCount: 2, threshold: 2 }
  const clearView = { branchId: 7, enabled: true, orderingAllowed: true, unacknowledgedCount: 1, threshold: 2 }
  const paymentClear = { orderingAllowed: true, overdueCount: 0, threshold: 2, reason: "NO_OVERDUE_PAYMENTS" }
  const paymentBlocked = { orderingAllowed: false, overdueCount: 2, threshold: 2, reason: "THRESHOLD_REACHED" }
  const reply = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

  /** Answers both pre-checks, the pending-invoice check and the order POST. */
  function stubFetch(answers: { deliveries: () => Response; paymentControl?: () => Response; order?: () => Response }) {
    const calls: Array<{ url: string; method: string }> = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      calls.push({ url, method })
      if (url.startsWith("/api/v1/orders/delivery-acknowledgement")) return answers.deliveries()
      if (url.startsWith("/api/v1/payment-control")) return answers.paymentControl ? answers.paymentControl() : reply(200, paymentClear)
      if (url === "/api/v1/orders/pending-invoice") return reply(200, { hasPendingInvoice: false, pendingInvoice: null })
      if (url === "/api/v1/orders" && method === "POST") {
        return answers.order ? answers.order() : reply(200, { order: { tid: "TID-1" } })
      }
      return reply(200, {})
    }))
    return calls
  }

  async function placeOrder() {
    render(<OrderPortalPage />)
    fireEvent.click(screen.getByRole("button", { name: /Add .* to Cart/ }))
    fireEvent.click(screen.getByRole("button", { name: "Open Cart" }))
    fireEvent.click(screen.getByRole("button", { name: /Proceed to checkout/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Place Order" }))
  }

  beforeEach(() => {
    localStorage.clear()
    mockStockedShop()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it("shows the popup and submits nothing when the branch is blocked", async () => {
    const calls = stubFetch({ deliveries: () => reply(200, blockedView) })
    await placeOrder()

    const popup = await screen.findByRole("alertdialog", { name: TITLE })
    expect(popup.textContent).toContain(BLOCKED_MESSAGE)
    // The Order Portal user asks for its own branch; the server resolves it.
    expect(calls.some((call) => call.url === "/api/v1/orders/delivery-acknowledgement")).toBe(true)
    expect(calls.some((call) => call.url === "/api/v1/orders/pending-invoice")).toBe(false)
    expect(calls.some((call) => call.url === "/api/v1/orders" && call.method === "POST")).toBe(false)
  })

  it("places the order when the branch has fewer than two", async () => {
    const calls = stubFetch({ deliveries: () => reply(200, clearView) })
    await placeOrder()

    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/orders" && call.method === "POST")).toBe(true)
    })
    expect(screen.queryByRole("alertdialog", { name: TITLE })).toBeNull()
  })

  it("places the order when the organization has the toggle off", async () => {
    const calls = stubFetch({ deliveries: () => reply(200, { branchId: 7, enabled: false, orderingAllowed: true, unacknowledgedCount: 0, threshold: 2 }) })
    await placeOrder()

    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/orders" && call.method === "POST")).toBe(true)
    })
  })

  it("shows the same popup when the server refuses the order, instead of a generic error", async () => {
    // The pre-check failed, so it let the order through; the server's gate is the control.
    stubFetch({
      deliveries: () => reply(500, { error: "Unable to load delivery acknowledgement status" }),
      order: () => reply(409, {
        error: BLOCKED_MESSAGE,
        code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED",
        deliveryAcknowledgement: { code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED", unacknowledgedCount: 2, threshold: 2 },
      }),
    })
    const toast = vi.fn()
    mocks.useToast.mockReturnValue({ toast })
    await placeOrder()

    const popup = await screen.findByRole("alertdialog", { name: TITLE })
    expect(popup.textContent).toContain(BLOCKED_MESSAGE)
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Failed" }))
  })

  it("when both blocks apply, shows the unpaid-invoices popup only, as the server would", async () => {
    const calls = stubFetch({ deliveries: () => reply(200, blockedView), paymentControl: () => reply(200, paymentBlocked) })
    await placeOrder()

    expect(await screen.findByRole("alertdialog", { name: "Unpaid invoices" })).toBeTruthy()
    expect(screen.queryByRole("alertdialog", { name: TITLE })).toBeNull()
    expect(calls.some((call) => call.url.startsWith("/api/v1/orders/delivery-acknowledgement"))).toBe(false)
  })

  it("closes the popup on OK", async () => {
    stubFetch({ deliveries: () => reply(200, blockedView) })
    await placeOrder()

    fireEvent.click(await screen.findByRole("button", { name: "OK" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: TITLE })).toBeNull())
  })
})

describe("OrderPortalPage unacknowledged orders tab", () => {
  const TAB_NAME = /Unacknowledged Orders \(\d+\)/
  const reply = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body }) as Response

  const delivered = (id: number, overrides: Record<string, unknown> = {}) => ({
    id,
    tid: `TID-${id}`,
    status: "APPROVED",
    fulfillmentStatus: "DELIVERED",
    deliveredAt: "2026-09-20T10:00:00.000Z",
    createdAt: "2026-09-18T10:00:00.000Z",
    totalCents: 1_000,
    approvalToken: `TOKEN${id}XYZ`,
    itemNames: "Test product",
    ...overrides,
  })

  function mockShopWithApprovedOrders(items: unknown[]) {
    mockStockedShop()
    const mutateSource = vi.fn()
    const base = mocks.useSWR.getMockImplementation()!
    mocks.useSWR.mockImplementation((url: string | null, ...rest: unknown[]) => {
      if (url === "/api/v1/orders?status=approved&limit=500") return { data: { items }, mutate: mutateSource }
      return (base as any)(url, ...rest)
    })
    return { mutateSource }
  }

  beforeEach(() => localStorage.clear())
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it("counts only delivered orders that are still unacknowledged", () => {
    mockShopWithApprovedOrders([
      delivered(1),
      delivered(2, { fulfillmentStatus: "DISPATCHED" }),
      delivered(3),
    ])
    render(<OrderPortalPage />)
    expect(screen.getByRole("button", { name: "Unacknowledged Orders (2)" })).toBeTruthy()
  })

  it("lists them in a table with the full token and a send action", async () => {
    mockShopWithApprovedOrders([delivered(1), delivered(2, { approvalToken: null, placedByGroupPortal: true })])
    render(<OrderPortalPage />)
    fireEvent.click(screen.getByRole("button", { name: TAB_NAME }))

    const table = await screen.findByRole("table", { name: "Delivered orders awaiting acknowledgement" })
    expect(table.textContent).toContain("TOKEN1XYZ")
    expect(screen.getByRole("button", { name: "Fulfil order TID-1 by emailing its token" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Fulfil order TID-2 by emailing its token" })).toBeNull()
  })

  it("emails the token for that order and refreshes the tab once it is fulfilled", async () => {
    const { mutateSource } = mockShopWithApprovedOrders([delivered(1)])
    const fetchMock = vi.fn(async () => reply(200, { fulfilled: true, message: "Token sent" }))
    vi.stubGlobal("fetch", fetchMock)
    render(<OrderPortalPage />)
    fireEvent.click(screen.getByRole("button", { name: TAB_NAME }))
    fireEvent.click(await screen.findByRole("button", { name: "Fulfil order TID-1 by emailing its token" }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/v1/orders/1/send-token-email", expect.objectContaining({ method: "POST" }))
    })
    await waitFor(() => expect(mutateSource.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it("takes a blocked user from the popup to the tab", async () => {
    mockShopWithApprovedOrders([delivered(1), delivered(2)])
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/api/v1/orders/delivery-acknowledgement")) {
        return reply(200, { branchId: 2, enabled: true, orderingAllowed: false, unacknowledgedCount: 2, threshold: 2 })
      }
      if (url.startsWith("/api/v1/payment-control")) {
        return reply(200, { orderingAllowed: true, overdueCount: 0, threshold: 2, reason: "NO_OVERDUE_PAYMENTS" })
      }
      return reply(200, {})
    }))
    render(<OrderPortalPage />)
    fireEvent.click(screen.getByRole("button", { name: /Add .* to Cart/ }))
    fireEvent.click(screen.getByRole("button", { name: "Open Cart" }))
    fireEvent.click(screen.getByRole("button", { name: /Proceed to checkout/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Place Order" }))

    fireEvent.click(await screen.findByRole("button", { name: "View unacknowledged orders" }))
    expect(await screen.findByRole("table", { name: "Delivered orders awaiting acknowledgement" })).toBeTruthy()
  })
})

describe("OrderPortalPage with budget allocation off", () => {
  const reply = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

  /** The stocked one-product shop, with the budget read answering `budget`. */
  function mockShopWithBudget(budget: Record<string, unknown>) {
    mockStockedShop()
    const stocked = mocks.useSWR.getMockImplementation()!
    mocks.useSWR.mockImplementation((url: string | null, ...rest: unknown[]) =>
      url?.startsWith("/api/v1/budgets")
        ? { data: budget, mutate: vi.fn() }
        : stocked(url, ...rest))
  }

  function stubFetch() {
    const calls: Array<{ url: string; method: string }> = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      calls.push({ url, method })
      if (url.startsWith("/api/v1/payment-control")) {
        return reply(200, { orderingAllowed: true, overdueCount: 0, threshold: 2, reason: "NOT_CONFIGURED" })
      }
      if (url === "/api/v1/orders/pending-invoice") return reply(200, { hasPendingInvoice: false, pendingInvoice: null })
      if (url === "/api/v1/orders" && method === "POST") return reply(200, { order: { tid: "TID-1" } })
      return reply(200, {})
    }))
    return calls
  }

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it("shows no budget figures and places an order the old budget check would have refused", async () => {
    localStorage.clear()
    // No figures at all, as the server answers a tenant with budgets off.
    mockShopWithBudget({ branchId: 2, budgetsEnabled: false })
    const calls = stubFetch()
    render(<OrderPortalPage />)

    fireEvent.click(screen.getByRole("button", { name: /Add .* to Cart/ }))
    fireEvent.click(screen.getByRole("button", { name: "Open Cart" }))

    expect(screen.queryByText(/Remaining budget after/)).toBeNull()
    expect(screen.queryByText(/Cart exceeds remaining budget/)).toBeNull()
    expect(screen.queryByText(/of PKR/)).toBeNull()
    const proceed = screen.getByRole("button", { name: /Proceed to checkout/ }) as HTMLButtonElement
    expect(proceed.disabled).toBe(false)

    fireEvent.click(proceed)
    expect(screen.queryByText(/Remaining Budget:/)).toBeNull()
    fireEvent.click(await screen.findByRole("button", { name: "Place Order" }))
    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/orders" && call.method === "POST")).toBe(true)
    })
  })

  it("still holds the cart back when budgets are on and the cart exceeds what is left", () => {
    localStorage.clear()
    // 5.00 left against a 10.00 product.
    mockShopWithBudget({ branchId: 2, budgetsEnabled: true, remainingCents: 500, amountAllocatedCents: 500, amountCreditedCents: 0 })
    stubFetch()
    render(<OrderPortalPage />)

    fireEvent.click(screen.getByRole("button", { name: /Add .* to Cart/ }))
    fireEvent.click(screen.getByRole("button", { name: "Open Cart" }))

    expect(screen.getAllByText(/Cart exceeds remaining budget/).length).toBeGreaterThan(0)
    expect((screen.getByRole("button", { name: /Proceed to checkout/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
