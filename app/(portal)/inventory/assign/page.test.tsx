import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The assignment page decides "not assigned" by subtracting the organization's
 * assignments from the global catalogue on the client. That only works when it
 * has the whole assignment list — the endpoint pages at 50 by default, and a
 * tenant with more assignments than that used to show the overflow as
 * unassigned, with the stat card reporting 50 whatever the true count was.
 */

const mocks = vi.hoisted(() => ({
  context: {
    organizationId: "10" as string | null,
    branchId: null as string | null,
    branchIds: [] as string[],
    userRole: "SUPER_ADMIN" as "SUPER_ADMIN" | "HEAD_OFFICE" | "BRANCH_ADMIN" | null,
    isInitialized: true,
  },
  products: [] as Array<{ id: number; productCode: string; name: string; basePrice: number; unit: string; status: string }>,
  assignments: { items: [] as Array<Record<string, unknown>>, total: undefined as number | undefined },
  swrKeys: [] as Array<string | null>,
  toast: vi.fn(),
}))

vi.mock("@/components/context/app-context", () => ({
  useAppContext: () => mocks.context,
}))

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}))

vi.mock("swr", () => ({
  default: (key: string | null) => {
    mocks.swrKeys.push(key)
    // A null key is a paused request (a dialog that is not open); SWR gives
    // it no data.
    if (key === null) {
      return { data: undefined, isLoading: false, mutate: vi.fn() }
    }
    if (key.startsWith("/api/v1/admin/global-inventory")) {
      return { data: { items: mocks.products }, isLoading: false, mutate: vi.fn() }
    }
    if (key.startsWith("/api/v1/admin/organization-assignments")) {
      return { data: mocks.assignments, isLoading: false, mutate: vi.fn() }
    }
    return { data: { items: [] }, isLoading: false, mutate: vi.fn() }
  },
}))

import AssignProductPage from "./page"

function product(id: number) {
  return { id, productCode: `PRD-${id}`, name: `Product ${id}`, basePrice: 1000, unit: "unit", status: "active" }
}

function assignment(globalProductId: number) {
  return {
    id: 100 + globalProductId,
    organizationId: 10,
    globalProductId,
    customPrice: null,
    customName: null,
    isActive: true,
    assignedAt: "2026-01-01T00:00:00.000Z",
    productName: `Product ${globalProductId}`,
    productCode: `PRD-${globalProductId}`,
    productImageUrl: null,
    organizationName: "Tenant",
  }
}

function assignmentsRequestKey(): string {
  const key = mocks.swrKeys.find((k) => k?.startsWith("/api/v1/admin/organization-assignments"))
  expect(key).toBeDefined()
  return key as string
}

beforeEach(() => {
  mocks.swrKeys.length = 0
  mocks.products = [product(1), product(2), product(3)]
  mocks.assignments = { items: [assignment(1)], total: 1 }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("AssignProductPage assignment list", () => {
  it("asks the endpoint for the whole assignment list, not its default page", () => {
    render(<AssignProductPage />)

    const params = new URL(assignmentsRequestKey(), "http://localhost").searchParams
    expect(params.get("organizationId")).toBe("10")
    expect(params.get("limit")).toBe("500")
  })

  it("requests the catalogue and the assignments with the same page size", () => {
    render(<AssignProductPage />)

    const catalogueKey = mocks.swrKeys.find((k) => k?.startsWith("/api/v1/admin/global-inventory")) as string
    const catalogueLimit = new URL(catalogueKey, "http://localhost").searchParams.get("limit")
    const assignmentsLimit = new URL(assignmentsRequestKey(), "http://localhost").searchParams.get("limit")
    expect(assignmentsLimit).toBe(catalogueLimit)
  })

  it("lists only the products the organization has not been assigned", () => {
    render(<AssignProductPage />)

    expect(screen.getByRole("tab", { name: "Not Assigned (2)" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Assigned (1)" })).toBeTruthy()
  })

  it("shows the count the endpoint reports, even when the items it returned are fewer", () => {
    // A tenant past the endpoint's ceiling: the items are one page, `total`
    // is the true figure. The stat card must trust `total`.
    mocks.assignments = { items: [assignment(1)], total: 154 }

    render(<AssignProductPage />)

    expect(screen.getByText("Assigned Products").nextElementSibling?.textContent).toBe("154")
  })

  it("falls back to the length of the list when the response carries no total", () => {
    mocks.assignments = { items: [assignment(1), assignment(2)], total: undefined }

    render(<AssignProductPage />)

    expect(screen.getByText("Assigned Products").nextElementSibling?.textContent).toBe("2")
  })

  it("sends only the organization and the page size until a filter is set", () => {
    render(<AssignProductPage />)

    const params = new URL(assignmentsRequestKey(), "http://localhost").searchParams
    expect([...params.keys()].sort()).toEqual(["limit", "organizationId"])
  })
})
