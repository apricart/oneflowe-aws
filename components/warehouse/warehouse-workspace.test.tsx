import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The warehouse workspace's side menu. Each section's own behaviour is pinned
 * by its own test; these stand-ins only say which one is on screen.
 */

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { fullName: "Store Keeper", email: "store@example.test" } } }),
}))
vi.mock("@/components/auth/order-portal-profile-menu", () => ({
  OrderPortalProfileMenu: ({ name }: { name: string }) => <div>{name}</div>,
}))
vi.mock("@/components/warehouse/warehouse-orders", () => ({ WarehouseOrders: () => <div>orders section</div> }))
vi.mock("@/components/warehouse/warehouse-catalog", () => ({ WarehouseCatalog: () => <div>catalog section</div> }))
vi.mock("@/components/delivery-dashboard/delivery-dashboard", () => ({
  DeliveryDashboard: ({ dashboardEndpoint }: { dashboardEndpoint: string }) => <div>workload section {dashboardEndpoint}</div>,
}))

import { WarehouseWorkspace } from "@/components/warehouse/warehouse-workspace"

const menu = () => within(screen.getByRole("navigation", { name: "Warehouse" }))
const current = () => menu().getAllByRole("button").filter((button) => button.getAttribute("aria-current") === "page")

beforeEach(() => window.history.replaceState(null, "", "/warehouse"))
afterEach(() => cleanup())

describe("the warehouse side menu", () => {
  it("offers the three sections in order and opens on Orders", () => {
    render(<WarehouseWorkspace />)
    expect(menu().getAllByRole("button").map((button) => button.textContent)).toEqual(["Orders", "Workload", "Product Catalog"])
    expect(current().map((button) => button.textContent)).toEqual(["Orders"])
    expect(screen.getByText("orders section")).toBeTruthy()
    expect(screen.queryByRole("tablist")).toBeNull()
  })

  it("shows one section at a time and remembers the choice in the URL hash", () => {
    render(<WarehouseWorkspace />)
    fireEvent.click(menu().getByRole("button", { name: "Workload" }))
    expect(screen.getByText("workload section /api/v1/warehouse/workload")).toBeTruthy()
    expect(screen.queryByText("orders section")).toBeNull()
    expect(current().map((button) => button.textContent)).toEqual(["Workload"])
    expect(window.location.hash).toBe("#workload")

    fireEvent.click(menu().getByRole("button", { name: "Product Catalog" }))
    expect(screen.getByText("catalog section")).toBeTruthy()
    expect(screen.queryByText(/workload section/)).toBeNull()
    expect(window.location.hash).toBe("#catalog")
  })

  it("opens the section a link names, and ignores a hash it does not know", () => {
    window.history.replaceState(null, "", "/warehouse#catalog")
    render(<WarehouseWorkspace />)
    expect(screen.getByText("catalog section")).toBeTruthy()
    cleanup()

    window.history.replaceState(null, "", "/warehouse#stock")
    render(<WarehouseWorkspace />)
    expect(screen.getByText("orders section")).toBeTruthy()
  })
})
