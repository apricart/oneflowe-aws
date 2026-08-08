import { readFileSync } from "fs"
import { resolve } from "path"

import { describe, expect, it } from "vitest"

describe("refund report contract", () => {
  it("exposes a role-scoped, filterable, itemized refund endpoint", () => {
    const route = readFileSync(
      resolve(process.cwd(), "app/api/v1/analytics/refunds/route.ts"),
      "utf8",
    )

    expect(route).toContain('eq(orders.branchId, branchId)')
    expect(route).toContain('inArray(orders.organizationId, scopedOrganizationIds)')
    expect(route).toContain('searchParams.get("refundType")')
    expect(route).toContain('searchParams.get("status")')
    expect(route).toContain("NULLIF(BTRIM(${refunds.reason}), '')")
    expect(route).toContain("NULLIF(BTRIM(${orders.refundReason}), '')")
    expect(route).toContain('items: itemsByRefund.get(refund.id) || []')
    expect(route).toContain('pagination: {')
  })

  it("keeps every refund money field hidden when analytics prices are restricted", () => {
    const visibility = readFileSync(resolve(process.cwd(), "lib/price-visibility.ts"), "utf8")
    for (const key of [
      "amountCents",
      "itemRefundCents",
      "taxRefundCents",
      "approvedAmountCents",
      "pendingAmountCents",
      "orderTotalCents",
    ]) {
      expect(visibility).toContain(`"${key}"`)
    }
  })

  it("links the report from every reports navigation", () => {
    const sidebar = readFileSync(resolve(process.cwd(), "components/shell/sidebar.tsx"), "utf8")
    const reportsHub = readFileSync(resolve(process.cwd(), "app/(portal)/reports/page.tsx"), "utf8")

    expect(sidebar.match(/href: "\/reports\/refund-report"/g)).toHaveLength(3)
    expect(reportsHub).toContain('href: "/reports/refund-report"')
  })

  it("shows the reason prominently and uses the grouped refund details drawer", () => {
    const page = readFileSync(
      resolve(process.cwd(), "app/(portal)/reports/refund-report/page.tsx"),
      "utf8",
    )
    const drawer = readFileSync(
      resolve(process.cwd(), "components/reports/refund-details-drawer.tsx"),
      "utf8",
    )

    expect(page).toContain("Refund Reason")
    expect(page).toContain("refund.reason || \"No reason was recorded for this refund.\"")
    expect(page).toContain("<RefundDetailsDrawer")
    expect(drawer).toContain("Refund reason")
    expect(drawer).toContain('title="Order"')
    expect(drawer).toContain('title="Location"')
    expect(drawer).toContain('title="People"')
    expect(drawer).toContain('title="Financial breakdown"')
  })
})
