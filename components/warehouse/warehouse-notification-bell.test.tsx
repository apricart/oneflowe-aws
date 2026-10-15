import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/** The warehouse's bell. plans/OF-WAREHOUSE-order-stage-notifications.md */

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  error: undefined as unknown,
  mutate: vi.fn(),
}))
vi.mock("swr", () => ({
  default: () => ({ data: state.data, error: state.error, isLoading: false, mutate: state.mutate }),
}))

import { WarehouseNotificationBell } from "@/components/warehouse/warehouse-notification-bell"

const items = [
  { id: 2, event: "APPROVED", title: "Order approved — ready to pick", message: "Order T2 (Clifton · KE) was approved and is in your queue.", createdAt: new Date().toISOString(), read: false, href: "/warehouse#orders" },
  { id: 1, event: "REJECTED", title: "Order rejected", message: "Order T1 (Clifton · KE) was rejected and will not be fulfilled.", createdAt: new Date().toISOString(), read: true, href: null },
]

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ updated: 1 })))

beforeEach(() => {
  state.data = { items, unreadCount: 1 }
  state.error = undefined
  state.mutate.mockReset()
  fetchMock.mockClear()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("the warehouse notification bell", () => {
  it("announces the unread count", () => {
    render(<WarehouseNotificationBell />)
    expect(screen.getByRole("button", { name: "Notifications, 1 unread" })).toBeTruthy()
  })

  it("lists the notices, links only the one in the queue, and marks them read on opening", async () => {
    render(<WarehouseNotificationBell />)
    fireEvent.click(screen.getByRole("button", { name: "Notifications, 1 unread" }))
    expect(screen.getByText("Order approved — ready to pick")).toBeTruthy()
    expect(screen.getByText("Order rejected")).toBeTruthy()
    const links = screen.getAllByRole("link", { name: "Open order queue" })
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute("href")).toBe("/warehouse#orders")
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/warehouse/notifications", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ action: "mark-all-read" }),
    }))
  })

  it("does not write when nothing is unread", () => {
    state.data = { items: [], unreadCount: 0 }
    render(<WarehouseNotificationBell />)
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }))
    expect(screen.getByText("No notifications yet.")).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("says so when the list cannot be loaded", () => {
    state.data = undefined
    state.error = new Error("boom")
    render(<WarehouseNotificationBell />)
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }))
    expect(screen.getByRole("alert").textContent).toBe("Notifications could not be loaded.")
  })
})
