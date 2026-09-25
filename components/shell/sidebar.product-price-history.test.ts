import { describe, expect, it } from "vitest"

import { getNavigationByRole } from "@/components/shell/sidebar"

type NavigationItem = {
  href: string
  label: string
  subItems?: Array<{ href: string; label: string }>
}

const productCatalog = (role: string) => getNavigationByRole(role)
  .find((item) => item.href === "/inventory") as NavigationItem | undefined

describe("role-scoped Product Catalog navigation", () => {
  it("gives Super Admin the renamed inventory hierarchy", () => {
    expect(productCatalog("SUPER_ADMIN")).toMatchObject({
      label: "Product Catalog",
      subItems: expect.arrayContaining([
        { href: "/inventory", label: "Global Products" },
        { href: "/inventory/price-history", label: "Product Price History" },
        { href: "/inventory/org", label: "Organization Products" },
        { href: "/inventory/branch/hub", label: "Group Products" },
      ]),
    })
  })

  it("gives Head Office only its organization products and scoped price history", () => {
    expect(productCatalog("HEAD_OFFICE")).toMatchObject({
      label: "Product Catalog",
      subItems: [
        { href: "/inventory", label: "Organization's Products" },
        { href: "/inventory/price-history", label: "Product Price History" },
      ],
    })
  })

  it.each(["BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER"])('does not expose price history to %s', (role) => {
    const navigation = getNavigationByRole(role) as NavigationItem[]
    const hasPriceHistory = navigation.some((item) =>
      item.href === "/inventory/price-history"
      || item.subItems?.some((subItem) => subItem.href === "/inventory/price-history"),
    )
    expect(hasPriceHistory).toBe(false)
  })
})
