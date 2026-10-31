import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
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
vi.mock("@/components/warehouse/warehouse-riders", () => ({ WarehouseRiders: () => <div>riders section</div> }))
vi.mock("@/components/warehouse/warehouse-catalog", () => ({ WarehouseCatalog: () => <div>catalog section</div> }))
vi.mock("@/components/warehouse/catalog/warehouse-organization-products", () => ({ WarehouseOrganizationProducts: () => <div>organization products section</div> }))
vi.mock("@/components/warehouse/catalog/warehouse-group-products", () => ({ WarehouseGroupProducts: () => <div>group products section</div> }))
vi.mock("@/components/warehouse/catalog/warehouse-product-requests", () => ({ WarehouseProductRequests: () => <div>product requests section</div> }))
vi.mock("@/components/warehouse/catalog/warehouse-taxonomy", () => ({ WarehouseTaxonomy: ({ level }: { level: string }) => <div>{level} taxonomy section</div> }))
vi.mock("next/dynamic", () => ({
  default: () => ({ endpoint, role }: { endpoint: string; role: string }) => <div>price history section {role} {endpoint}</div>,
}))
vi.mock("@/components/warehouse/warehouse-notification-bell", () => ({ WarehouseNotificationBell: () => <button type="button">bell</button> }))
vi.mock("@/components/warehouse/warehouse-support-link", async () => {
  const { default: Link } = await import("next/link")
  return { WarehouseSupportLink: () => <Link href="/support">Support</Link> }
})
vi.mock("@/components/delivery-dashboard/delivery-dashboard", () => ({
  DeliveryDashboard: ({ dashboardEndpoint, warehouseOrderIdTools }: { dashboardEndpoint: string; warehouseOrderIdTools?: boolean }) => (
    <div>dashboard section {dashboardEndpoint} {warehouseOrderIdTools ? "with order ID tools" : ""}</div>
  ),
}))

import { WarehouseWorkspace } from "@/components/warehouse/warehouse-workspace"

const menu = () => within(screen.getByRole("navigation", { name: "Warehouse" }))
const current = () => menu().getAllByRole("button").filter((button) => button.getAttribute("aria-current") === "page")

beforeEach(() => window.history.replaceState(null, "", "/warehouse"))
afterEach(() => cleanup())

describe("the warehouse side menu", () => {
  it("offers the sections in order and opens on the Dashboard", () => {
    render(<WarehouseWorkspace />)
    expect(menu().getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Dashboard",
      "Orders",
      "Riders",
      "Requisitions",
      "Receiving",
      "Customer returns",
      "Product Catalog",
    ])
    expect(menu().getByRole("button", { name: "Product Catalog" }).getAttribute("aria-expanded")).toBe("false")
    expect(current().map((button) => button.textContent)).toEqual(["Dashboard"])
    expect(screen.getByText("dashboard section /api/v1/warehouse/workload with order ID tools")).toBeTruthy()
    expect(screen.queryByRole("tablist")).toBeNull()
  })

  it("shows one section at a time and remembers the choice in the URL hash", () => {
    render(<WarehouseWorkspace />)
    fireEvent.click(menu().getByRole("button", { name: "Orders" }))
    expect(screen.getByText("orders section")).toBeTruthy()
    expect(screen.queryByText(/dashboard section/)).toBeNull()
    expect(current().map((button) => button.textContent)).toEqual(["Orders"])
    expect(window.location.hash).toBe("#orders")

    fireEvent.click(menu().getByRole("button", { name: "Product Catalog" }))
    fireEvent.click(menu().getByRole("button", { name: "Global Products" }))
    expect(screen.getByText("catalog section")).toBeTruthy()
    expect(screen.queryByText("orders section")).toBeNull()
    expect(window.location.hash).toBe("#catalog")
  })

  it("opens the section a link names, and ignores a hash it does not know", () => {
    window.history.replaceState(null, "", "/warehouse#catalog")
    render(<WarehouseWorkspace />)
    expect(screen.getByText("catalog section")).toBeTruthy()
    cleanup()

    window.history.replaceState(null, "", "/warehouse#stock")
    render(<WarehouseWorkspace />)
    expect(screen.getByText(/dashboard section/)).toBeTruthy()
  })

  it("follows a link inside the page that changes the section", () => {
    render(<WarehouseWorkspace />)
    window.history.replaceState(null, "", "/warehouse#orders")
    act(() => { window.dispatchEvent(new HashChangeEvent("hashchange")) })
    expect(screen.getByText("orders section")).toBeTruthy()
    expect(current().map((button) => button.textContent)).toEqual(["Orders"])
  })

  it("links to the support queue of its branches, below the sections", () => {
    render(<WarehouseWorkspace />)
    expect(menu().getByRole("link", { name: "Support" }).getAttribute("href")).toBe("/support")
  })

  it("puts the notification bell in the header", () => {
    render(<WarehouseWorkspace />)
    expect(screen.getByRole("button", { name: "bell" })).toBeTruthy()
  })

  it("still opens the Dashboard from a link saved when it was called Workload", () => {
    window.history.replaceState(null, "", "/warehouse#workload")
    render(<WarehouseWorkspace />)
    expect(screen.getByText(/dashboard section/)).toBeTruthy()
    expect(current().map((button) => button.textContent)).toEqual(["Dashboard"])
    expect(window.location.hash).toBe("#dashboard")
  })

  it("opens the Product Catalog submenu with Super Admin's seven menus, in its order", () => {
    render(<WarehouseWorkspace />)
    fireEvent.click(menu().getByRole("button", { name: "Product Catalog" }))
    expect(menu().getByRole("button", { name: "Product Catalog" }).getAttribute("aria-expanded")).toBe("true")
    const submenu = within(screen.getByRole("list", { name: "Product Catalog" }))
    expect(submenu.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Global Products",
      "Product Price History",
      "Organization Products",
      "Group Products",
      "Categories",
      "Subcategories",
      "Product Requests",
    ])
    fireEvent.click(menu().getByRole("button", { name: "Product Catalog" }))
    expect(screen.queryByRole("list", { name: "Product Catalog" })).toBeNull()
  })

  it.each([
    ["Product Price History", "price history section WAREHOUSE /api/v1/warehouse/catalog/price-history", "#catalog-price-history"],
    ["Organization Products", "organization products section", "#catalog-organization-products"],
    ["Group Products", "group products section", "#catalog-group-products"],
    ["Categories", "category taxonomy section", "#catalog-categories"],
    ["Subcategories", "subcategory taxonomy section", "#catalog-subcategories"],
    ["Product Requests", "product requests section", "#catalog-product-requests"],
  ])("opens %s on its own, read-only view", (label, text, hash) => {
    render(<WarehouseWorkspace />)
    fireEvent.click(menu().getByRole("button", { name: "Product Catalog" }))
    fireEvent.click(menu().getByRole("button", { name: label }))
    expect(screen.getByText(text)).toBeTruthy()
    expect(screen.queryByText(/dashboard section/)).toBeNull()
    expect(window.location.hash).toBe(hash)
    expect(current().map((button) => button.textContent)).toEqual([label])
  })

  it("opens the submenu at the catalogue view a link names", () => {
    window.history.replaceState(null, "", "/warehouse#catalog-group-products")
    render(<WarehouseWorkspace />)
    expect(screen.getByText("group products section")).toBeTruthy()
    expect(screen.getByRole("list", { name: "Product Catalog" })).toBeTruthy()
  })
})
