import { readFileSync } from "fs"
import { resolve } from "path"

import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("K-Electric legacy reporting contract", () => {
  it("persists every timestamp used to represent a delivered historical order", () => {
    const importer = source("scripts/import-ke-legacy-orders.ts")

    expect(importer).toContain("created_by_user_id, created_at, delivered_at, fulfilled_at, updated_at")
    expect(importer).toContain("${orderValue.deliveredAt}, ${orderValue.fulfilledAt}, ${orderValue.updatedAt}")
  })

  it("supports report-local multi-organization filters and all-time years", () => {
    const route = source("app/api/v1/analytics/summary/route.ts")
    const page = source("app/(portal)/reports/order-report/page.tsx")

    expect(route).toContain('url.searchParams.get("organizationIds")')
    expect(route).toContain("inArray(orders.organizationId, scopedOrganizationIds)")
    expect(route).toContain('url.searchParams.get("allTime") === "true"')
    expect(page).toContain("Array.isArray(allTimeData?.years)")
  })
})
