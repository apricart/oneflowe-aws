import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import {
  GROUP_ORDER_REPORT_PAGE_SIZE_MAX,
  MAX_GROUP_FILTER_IDS,
  parseGroupFilterIds,
  parseGroupOrderReportStatus,
  parseReportPageSize,
} from "@/lib/server/group-order-report-filters"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n")

/**
 * The group order report is a second read path over order data, so the contract
 * that matters is that it cannot become a weaker one. These pin the scope to
 * the approver's own assignments, keep the surface read-only, and keep every
 * other role's routing untouched.
 */
describe("group order report filter parsing", () => {
  it("accepts only the statuses the report defines", () => {
    expect(parseGroupOrderReportStatus("pending")).toBe("PENDING")
    expect(parseGroupOrderReportStatus("REFUNDED")).toBe("REFUNDED")
  })

  it("falls back to ALL rather than passing an unknown value into a query", () => {
    for (const value of ["", null, undefined, "DROP TABLE orders", "'; --", 7, {}]) {
      expect(parseGroupOrderReportStatus(value)).toBe("ALL")
    }
  })

  it("keeps only positive integer group ids, de-duplicated and capped", () => {
    expect(parseGroupFilterIds("3,3,7")).toEqual([3, 7])
    expect(parseGroupFilterIds("0,-1,abc,1.5, 9 ")).toEqual([9])
    expect(parseGroupFilterIds(null)).toEqual([])
    expect(parseGroupFilterIds(
      Array.from({ length: MAX_GROUP_FILTER_IDS + 50 }, (_, index) => index + 1).join(","),
    )).toHaveLength(MAX_GROUP_FILTER_IDS)
  })

  it("clamps the page size instead of honouring an oversized request", () => {
    expect(parseReportPageSize("25")).toBe(25)
    expect(parseReportPageSize("100000")).toBe(GROUP_ORDER_REPORT_PAGE_SIZE_MAX)
    expect(parseReportPageSize("-4")).toBe(10)
    expect(parseReportPageSize(null)).toBe(10)
  })
})

describe("group order report scoping", () => {
  const reporting = source("lib/server/group-order-reporting.ts")

  it("builds every read on the approver's tenant and assigned branches", () => {
    expect(reporting).toContain("eq(orders.organizationId, scope.organizationId)")
    expect(reporting).toContain("inArray(orders.branchId, scope.branchIds)")
    // An empty scope is a deny, resolved by the same helper the approval queue
    // uses, and never widened into an unfiltered read.
    expect(reporting).toContain("approverScope(organizationId, scopedBranchIds)")
    expect(reporting).toContain("if (!scope.usable) return emptyPage(page, limit)")
    expect(reporting).toContain("if (!scope.usable) return emptySummary")
    expect(reporting).toContain("if (!scope.usable) return []")
  })

  it("re-asserts the branch scope on the child read rather than trusting the envelope", () => {
    const childRead = reporting.slice(
      reporting.indexOf("const childRows = await db"),
      reporting.indexOf("const childrenByEnvelope"),
    )
    expect(childRead).toContain("...childConditions(scope, filters)")
    expect(childRead).toContain("inArray(orders.groupOrderId, envelopeIds)")
  })

  it("keeps the envelope read inside the caller's tenant", () => {
    expect(reporting).toContain("eq(groupOrders.organizationId, scope.organizationId)")
  })

  it("escapes the reference search instead of interpolating it into a pattern", () => {
    expect(reporting).toContain("escapeLikePattern(reference.slice(0, GROUP_ORDER_REFERENCE_MAX_LENGTH))")
  })

  it("never returns a fulfillment token from the reporting path", () => {
    // The approval queue exposes the token deliberately and gates it on a
    // shared policy; the report has no reason to carry a credential at all.
    expect(reporting).not.toContain("approvalToken")
  })

  it("performs no writes", () => {
    for (const mutation of ["db.insert(", "db.update(", "db.delete(", "db.transaction("]) {
      expect(reporting).not.toContain(mutation)
    }
  })
})

describe("group order report endpoint", () => {
  const route = source("app/api/v1/group-portal/reports/group-orders/route.ts")

  it("allowlists the approver alone and takes its scope from the session", () => {
    expect(route).toContain("requireGroupApprover()")
    expect(route).toContain("organizationId: actor.organizationId")
    expect(route).toContain("scopedBranchIds: actor.scopedBranchIds")
  })

  it("never reads a branch, organization or user identifier from the query string", () => {
    for (const param of ["branchId", "branchIds", "organizationId", "userId"]) {
      expect(route).not.toContain(`searchParams.get("${param}")`)
    }
  })

  it("exposes no mutating handler", () => {
    for (const method of ["export async function POST", "export async function PATCH", "export async function PUT", "export async function DELETE"]) {
      expect(route).not.toContain(method)
    }
  })

  it("bounds the page size and the group filter", () => {
    expect(route).toContain("limit: parseReportPageSize(searchParams.get(\"limit\"))")
    expect(route).toContain("parseGroupFilterIds(searchParams.get(\"groupIds\"))")
    expect(GROUP_ORDER_REPORT_PAGE_SIZE_MAX).toBeLessThanOrEqual(50)
  })
})

describe("group order report navigation", () => {
  it("gates the page to the approver on the server", () => {
    const layout = source("app/(portal)/reports/group-orders/layout.tsx")
    expect(layout).toContain("!== GROUP_USER_ROLE) redirect(")
  })

  it("offers the report to the approver and to no other role", () => {
    const sidebar = source("components/shell/sidebar.tsx")
    const groupUserNav = sidebar.slice(
      sidebar.indexOf('if (role === "GROUP_USER")'),
      sidebar.indexOf("return baseNav"),
    )
    expect(groupUserNav).toContain('href: "/reports/group-orders"')

    const hub = source("app/(portal)/reports/page.tsx")
    // The card lives outside the shared list, so it is appended for this role
    // only rather than filtered back out of everyone else's hub.
    expect(hub).toContain("const groupUserOnlyReportCards = [")
    expect(hub).toContain('role === "GROUP_USER"\n    ? [...reportCards, ...groupUserOnlyReportCards]\n    : reportCards')
    expect(hub).toContain('"/reports/group-orders",')
  })
})

describe("report column preferences", () => {
  const selector = source("components/reports/column-selector.tsx")

  it("records the column set a preference was written against", () => {
    expect(selector).toContain("type StoredColumnPreference = { visible: string[]; known: string[] }")
    expect(selector).toContain("JSON.stringify({ visible: visibleKeys, known:")
  })

  it("shows a column the stored preference never knew about", () => {
    // Without this a saved preference permanently suppresses every column added
    // later — which is why Group Order ID never appeared for existing users.
    expect(selector).toContain("!known.has(c.key) && c.defaultVisible !== false")
  })

  it("still honours a column the user deliberately hid", () => {
    expect(selector).toContain("&& !savedSet.has(c.key)")
  })
})

describe("group order report quantities", () => {
  const reporting = source("lib/server/group-order-reporting.ts")
  const report = source("components/group-portal/group-order-report.tsx")

  it("keeps a quantity total at the scale the column is stored at", () => {
    // `order_items.quantity` is numeric(12,3). Casting the sum to an integer
    // rounded the headline away from the rows underneath it, so three orders of
    // 0.5 read as 2 in the tile and 1.5 in the list.
    expect(reporting).toContain("const quantityTotalExpression =")
    expect(reporting).toContain("COALESCE(SUM(${orderQuantityExpression}), 0)::numeric")
    expect(reporting).not.toContain("COALESCE(SUM(${orderQuantityExpression}), 0)::int")
  })

  it("re-rounds the totals it adds up in JavaScript", () => {
    expect(reporting).toContain("function sumQuantities(")
    expect(reporting).toContain("quantityOrdered: sumQuantities(")
    expect(reporting).toContain("quantityOrdered: roundQuantity(Number(row?.quantityOrdered ?? 0))")
  })

  it("leaves the money totals as the integers they already are", () => {
    expect(reporting).toContain("COALESCE(SUM(${orders.totalCents}), 0)::bigint")
    expect(reporting).toContain("COALESCE(SUM(${refundCentsExpression}), 0)::bigint")
  })

  it("formats every quantity it renders rather than printing a raw float", () => {
    expect(report).toContain("formatQuantity(summary?.quantityOrdered ?? 0)")
    expect(report).toContain("formatQuantity(row.quantityOrdered)")
    expect(report).toContain("formatQuantity(child.quantityOrdered)")
  })

  it("does not label a quantity total as a count of items", () => {
    // 2.5 kg is not "2.5 items".
    expect(report).toContain("units ordered")
    expect(report).not.toContain('{row.quantityOrdered} item{')
  })
})
