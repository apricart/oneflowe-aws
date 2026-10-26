import { describe, expect, it } from "vitest"

import { getNavigationByRole, withoutOrderingBlocksNavigation } from "@/components/shell/sidebar"
import { ORDERING_BLOCKS_AREA } from "@/lib/ordering-blocks-access"

/**
 * The Ordering Blocks entry is offered to Head Office only, and only while
 * its organization blocks ordering on unpaid invoices
 * (plans/OF-PAYMENT-CONTROL-head-office-ordering-blocks-page.md). The menu is
 * presentation; the list, grant and revoke endpoints refuse on their own.
 */

const hasEntry = (role: string, enabled: boolean, organizationWideViewer = false) =>
  getNavigationByRole(role, false, true, organizationWideViewer, enabled).some((item) => item.href === ORDERING_BLOCKS_AREA)

describe("the Ordering Blocks entry", () => {
  it("is offered to Head Office when its organization blocks on unpaid invoices", () => {
    expect(hasEntry("HEAD_OFFICE", true)).toBe(true)
  })

  it("is not offered to Head Office while the block is off, or before the server has said", () => {
    expect(hasEntry("HEAD_OFFICE", false)).toBe(false)
    expect(getNavigationByRole("HEAD_OFFICE").some((item) => item.href === ORDERING_BLOCKS_AREA)).toBe(false)
  })

  it("is never offered to an organization-wide Viewer, though it reads Head Office's menu", () => {
    expect(hasEntry("VIEWER", true, true)).toBe(false)
  })

  it.each(["SUPER_ADMIN", "BRANCH_ADMIN", "GROUP_USER", "ORDER_PORTAL", "GROUP_ORDER_PORTAL"])("is never offered to %s", (role) => {
    expect(hasEntry(role, true)).toBe(false)
  })

  it("leaves the rest of Head Office's menu as it was", () => {
    const on = getNavigationByRole("HEAD_OFFICE", false, true, false, true).map((item) => item.href)
    const off = getNavigationByRole("HEAD_OFFICE", false, true, false, false).map((item) => item.href)
    expect(off).toEqual(on.filter((href) => href !== ORDERING_BLOCKS_AREA))
    expect(withoutOrderingBlocksNavigation([{ href: ORDERING_BLOCKS_AREA }, { href: "/orders" }])).toEqual([{ href: "/orders" }])
  })
})
