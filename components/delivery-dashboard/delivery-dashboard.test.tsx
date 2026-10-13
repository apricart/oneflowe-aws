import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  buildDeliveryDashboard,
  parseDeliveryDashboardQuery,
  type DeliveryOrderRow,
} from "@/lib/delivery-dashboard"

/**
 * Clicking a KPI card narrows the order list below it to that card's orders.
 * The server does the narrowing, so SWR is stood in for by the real pure
 * builder: each requested URL is parsed and answered exactly as the route
 * would, which keeps the cards and the list honest with each other.
 */

const HOUR = 60 * 60 * 1000
const now = new Date("2026-10-06T07:00:00.000Z")

let nextId = 0
const order = (approvedHoursAgo: number, overrides: Partial<DeliveryOrderRow> = {}): DeliveryOrderRow => {
  nextId += 1
  return {
    id: nextId,
    tid: `T${nextId}`,
    organizationId: 1,
    organizationName: "KE",
    branchId: 10,
    branchName: "Clifton",
    branchCity: "Karachi",
    branchRegion: "SOUTH",
    deliveryAddressCity: null,
    status: "APPROVED",
    fulfillmentStatus: "IN_PROCESS",
    approvedAt: new Date(now.getTime() - approvedHoursAgo * HOUR),
    deliveredAt: null,
    ...overrides,
  }
}

const rows = [
  order(99, { fulfillmentStatus: "OUT_FOR_DELIVERY" }), // T1 overdue
  order(80), // T2 overdue
  order(60, { fulfillmentStatus: "NOT_STARTED" }), // T3 due soon
  order(5), // T4 on track
  order(50, { fulfillmentStatus: "DELIVERED", deliveredAt: new Date(now.getTime() - 2 * HOUR) }), // T5 delivered on time
]

const requested: string[] = []

vi.mock("swr", () => ({
  default: (key: string | null) => {
    // Only the dashboard read is answered; the order timeline stays closed.
    if (!key || key.includes("/timeline")) {
      return { data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn() }
    }
    requested.push(key)
    const parsed = parseDeliveryDashboardQuery(new URL(key, "http://localhost").searchParams, now)
    if (!parsed.ok) throw new Error(parsed.message)
    const data = buildDeliveryDashboard({
      rows,
      filters: parsed.filters,
      now,
      truncated: false,
      organizations: [{ id: 1, name: "KE" }],
      branches: [],
      listOrder: "newest",
    })
    return { data, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn() }
  },
}))

import { DeliveryDashboard } from "@/components/delivery-dashboard/delivery-dashboard"

const card = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) })
/** The order references in the list, which are the only buttons named T<n>. */
const listedOrders = () => screen.queryAllByRole("button", { name: /^T\d+$/ }).map((button) => button.textContent)

const originalScrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
  requested.length = 0
})
afterEach(() => {
  cleanup()
  Element.prototype.scrollIntoView = originalScrollIntoView
})

describe("choosing a KPI card", () => {
  it("lists only that card's orders, names the card on the list, and counts them", () => {
    render(<DeliveryDashboard dashboardEndpoint="/api/v1/warehouse/workload" />)
    expect(screen.getByText("Orders, newest first")).toBeTruthy()
    expect(listedOrders()).toHaveLength(5)

    fireEvent.click(card("Overdue"))
    expect(requested.at(-1)).toContain("/api/v1/warehouse/workload?view=OVERDUE")
    expect(card("Overdue").getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByText("Orders: Overdue")).toBeTruthy()
    expect(screen.getByText("2 orders · chosen from the cards above")).toBeTruthy()
    expect(listedOrders().sort()).toEqual(["T1", "T2"])

    fireEvent.click(card("Due soon"))
    expect(screen.getByText("Orders: Due soon")).toBeTruthy()
    expect(listedOrders()).toEqual(["T3"])

    fireEvent.click(card("Not started"))
    expect(listedOrders()).toEqual(["T3"])

    fireEvent.click(card("Delivered · awaiting"))
    expect(listedOrders()).toEqual(["T5"])
  })

  it("says so when the chosen card has no orders", () => {
    render(<DeliveryDashboard />)
    fireEvent.click(card("Fulfilled"))
    expect(screen.getByText("0 orders · chosen from the cards above")).toBeTruthy()
    expect(screen.getByText("No orders match these filters.")).toBeTruthy()
  })

  it("brings the list into view when a card is chosen", () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(<DeliveryDashboard />)
    fireEvent.click(card("On track"))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(listedOrders()).toEqual(["T4"])
  })

  it("returns to every order from Show all, or by clicking the chosen card again", () => {
    render(<DeliveryDashboard />)
    fireEvent.click(card("Overdue"))
    fireEvent.click(screen.getByRole("button", { name: "Show all" }))
    expect(screen.getByText("Orders, newest first")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull()
    expect(listedOrders()).toHaveLength(5)

    fireEvent.click(card("Overdue"))
    fireEvent.click(card("Overdue"))
    expect(requested.at(-1)).not.toContain("view=")
    expect(listedOrders()).toHaveLength(5)
  })
})
