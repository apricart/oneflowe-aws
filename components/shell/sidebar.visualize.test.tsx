import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * The Visualize group under Reports, and the matcher that lights exactly one
 * of its leaves.
 *
 * Both leaves live on one page, `/reports/graphical`, and differ only by the
 * `?tab=` the page reads — so the old path-only match would have lit
 * Executive Overview on both screens. The matcher is pure and tested on its
 * own; the rendered walk then checks the menu a reader actually clicks
 * through, and that the page they are on is the one marked.
 */

const navigation = vi.hoisted(() => ({
  pathname: "/dashboard",
  search: "",
}))

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}))
vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: "authenticated", data: { user: { role: "SUPER_ADMIN" } } }),
}))
vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}))

import { Sidebar, activeEntryHref, getNavigationByRole } from "@/components/shell/sidebar"

const VISUALIZE_LEAVES = [
  { href: "/reports/graphical", label: "Executive Overview" },
  { href: "/reports/graphical?tab=product-performance", label: "Product Performance" },
]

const params = (search: string) => new URLSearchParams(search)

describe("activeEntryHref", () => {
  it("lights the plain entry on its path when the URL carries no query", () => {
    expect(activeEntryHref(VISUALIZE_LEAVES, "/reports/graphical", params(""))).toBe("/reports/graphical")
  })

  it("lets the entry whose query matches win over its plain sibling", () => {
    expect(activeEntryHref(VISUALIZE_LEAVES, "/reports/graphical", params("tab=product-performance")))
      .toBe("/reports/graphical?tab=product-performance")
  })

  it("falls back to the plain sibling when the query names another value", () => {
    // A tab the page does not offer falls back to the overview there too.
    expect(activeEntryHref(VISUALIZE_LEAVES, "/reports/graphical", params("tab=explore"))).toBe("/reports/graphical")
  })

  it("ignores query parameters the entry does not mention", () => {
    expect(activeEntryHref(VISUALIZE_LEAVES, "/reports/graphical", params("tab=product-performance&period=quarter")))
      .toBe("/reports/graphical?tab=product-performance")
    expect(activeEntryHref(VISUALIZE_LEAVES, "/reports/graphical", params("period=quarter"))).toBe("/reports/graphical")
  })

  it("matches on the path exactly, never on a prefix, and returns null off it", () => {
    expect(activeEntryHref(VISUALIZE_LEAVES, "/reports/graphical/other", params(""))).toBeNull()
    expect(activeEntryHref(VISUALIZE_LEAVES, "/reports", params("tab=product-performance"))).toBeNull()
    expect(activeEntryHref([], "/reports/graphical", params(""))).toBeNull()
  })

  it("keeps lighting a plain entry whose page happens to carry a query of its own", () => {
    // Orders filtered by status is still the Orders entry.
    expect(activeEntryHref([{ href: "/orders" }, { href: "/refunds" }], "/orders", params("status=pending"))).toBe("/orders")
  })
})

describe("the Visualize group", () => {
  const reportsOf = (role: string) =>
    getNavigationByRole(role).find((item) => item.href === "/reports") as { subItems?: any[] } | undefined

  it.each(["SUPER_ADMIN", "HEAD_OFFICE", "GROUP_USER"])("is the first report offered to %s, with the two levels beneath it", (role) => {
    const visualize = reportsOf(role)?.subItems?.[0]
    expect(visualize).toMatchObject({ href: "/reports/graphical", label: "Visualize" })
    expect(visualize.subItems).toEqual(VISUALIZE_LEAVES)
  })

  it.each(["SUPER_ADMIN", "HEAD_OFFICE", "GROUP_USER"])("replaces the flat Graphical Reports entry for %s rather than sitting beside it", (role) => {
    const labels = reportsOf(role)?.subItems?.map((entry) => entry.label) ?? []
    expect(labels).not.toContain("Graphical Reports")
    expect(labels.filter((label) => label === "Product Performance")).toHaveLength(0)
  })

  it("is not offered to a Branch Admin, whose scope is one branch", () => {
    const labels = reportsOf("BRANCH_ADMIN")?.subItems?.map((entry) => entry.label) ?? []
    expect(labels).not.toContain("Visualize")
    expect(labels).not.toContain("Graphical Reports")
  })
})

describe("the rendered menu", () => {
  afterEach(() => {
    cleanup()
    navigation.pathname = "/dashboard"
    navigation.search = ""
  })

  function openVisualize() {
    render(<Sidebar />)
    fireEvent.click(screen.getByRole("button", { name: "Reports" }))
    fireEvent.click(screen.getByRole("button", { name: "Visualize" }))
    return {
      overview: screen.getByRole("link", { name: "Executive Overview" }),
      productPerformance: screen.getByRole("link", { name: "Product Performance" }),
    }
  }

  it("opens Visualize under Reports onto two links, one per level of the page", () => {
    const { overview, productPerformance } = openVisualize()
    expect(overview.getAttribute("href")).toBe("/reports/graphical")
    expect(productPerformance.getAttribute("href")).toBe("/reports/graphical?tab=product-performance")
    // Neither is the current page from the dashboard.
    expect(overview.getAttribute("aria-current")).toBeNull()
    expect(productPerformance.getAttribute("aria-current")).toBeNull()
  })

  it("marks Executive Overview, and only it, on the overview", () => {
    navigation.pathname = "/reports/graphical"
    const { overview, productPerformance } = openVisualize()
    expect(overview.getAttribute("aria-current")).toBe("page")
    expect(productPerformance.getAttribute("aria-current")).toBeNull()
  })

  it("marks Product Performance, and only it, on that tab", () => {
    navigation.pathname = "/reports/graphical"
    navigation.search = "tab=product-performance"
    const { overview, productPerformance } = openVisualize()
    expect(productPerformance.getAttribute("aria-current")).toBe("page")
    expect(overview.getAttribute("aria-current")).toBeNull()
  })

  it("keeps the other reports as direct links beside the group", () => {
    render(<Sidebar />)
    const reports = screen.getByRole("button", { name: "Reports" })
    fireEvent.click(reports)
    const group = reports.parentElement as HTMLElement
    expect(within(group).getByRole("link", { name: "Order Report" }).getAttribute("href")).toBe("/reports/order-report")
    // The Visualize leaves stay folded until the group is opened.
    expect(within(group).queryByRole("link", { name: "Executive Overview" })).toBeNull()
  })
})
