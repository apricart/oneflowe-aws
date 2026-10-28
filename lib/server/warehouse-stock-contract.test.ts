import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * The control on per-warehouse stock (plans/OF-STOCK-per-warehouse-stock.md).
 * Stock is moved by many paths; these lists are what keeps a new one from
 * taking or giving back global stock while stock is counted per warehouse, or
 * from creating an order no warehouse check has seen. A new path goes on the
 * matching list, or this fails.
 */

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n")

/** Every application file that writes `global_products.stock_quantity` from an order. */
const ORDER_GLOBAL_STOCK_WRITERS = [
  "app/api/v1/orders/route.ts",
  "app/api/v1/orders/[id]/route.ts",
  "app/api/v1/admin/delete-order/route.ts",
  "lib/server/group-order-creation.ts",
  "lib/server/group-order-cancel.ts",
  "lib/server/order-decision-service.ts",
  "lib/server/order-desk-edit.ts",
  "lib/server/order-desk-orders.ts",
]

/** Super Admin's product writes and the K-Electric catalogue sync: the global figure itself, unread per warehouse. */
const CATALOGUE_GLOBAL_STOCK_WRITERS = [
  "app/api/v1/admin/global-inventory/route.ts",
  "app/api/v1/admin/global-inventory/import/route.ts",
  "lib/legacy-import/ke-branch-catalogue.ts",
]

/** Every path that creates or edits an order's lines, and the warehouse check each makes. */
const ORDER_LINE_WRITERS: Record<string, string> = {
  "app/api/v1/orders/route.ts": "assertWarehouseStockAvailable(",
  "app/api/v1/orders/[id]/route.ts": "assertWarehouseStockAvailable(",
  "lib/server/group-order-creation.ts": "assertWarehouseStockAvailable(",
  "lib/server/order-desk-edit.ts": "findStockShortfalls(",
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : walk(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path.replace(/\\/g, "/")] : []
  })
}

const sources = [...walk("app"), ...walk("lib")]

describe("per-warehouse stock: who moves the global figure", () => {
  it("lists every application file that writes the global stock figure", () => {
    const writers = sources.filter((path) => /stockQuantity:\s*(sql`|nextStock|normalizedStockQuantity|options\.stockLevel|row\.stockQuantity|quantity\.stockQuantity)/.test(read(path))
      || /updateData\.stockQuantity\s*=/.test(read(path)))
    expect(writers.sort()).toEqual([...ORDER_GLOBAL_STOCK_WRITERS, ...CATALOGUE_GLOBAL_STOCK_WRITERS].sort())
  })

  it("skips every order-driven take or give-back of the global figure while stock is counted per warehouse", () => {
    for (const path of ORDER_GLOBAL_STOCK_WRITERS) {
      const source = read(path)
      expect(source, path).toContain('from "@/lib/stock-ledger-policy"')
      expect(source.includes("usesWarehouseStock() ? []") || source.includes("if (usesWarehouseStock()) return"), path).toBe(true)
    }
  })
})

describe("per-warehouse stock: every new or edited order is checked against a warehouse", () => {
  it.each(Object.entries(ORDER_LINE_WRITERS))("%s checks the warehouse when stock is counted per warehouse", (path, call) => {
    const source = read(path)
    expect(source).toContain("if (usesWarehouseStock()) {")
    expect(source).toContain(call)
  })

  it("edits leave out the order's own reservation", () => {
    expect(read("app/api/v1/orders/[id]/route.ts")).toContain("excludeOrderId: access.existingOrder.id")
    expect(read("lib/server/order-desk-edit.ts")).toContain("excludeOrderId: order.id")
  })
})

describe("per-warehouse stock: goods leave the shelf only at In Process", () => {
  it("issues inside the step from Not Started, in the transaction that issues the tax invoice", () => {
    const source = read("lib/server/order-fulfillment-progress.ts")
    const issue = source.indexOf("await issueOrderStock(tx")
    expect(issue).toBeGreaterThan(-1)
    expect(source.slice(issue - 200, issue)).toContain('usesWarehouseStock() && currentStatus === "NOT_STARTED"')
    expect(issue).toBeLessThan(source.indexOf("await issueTaxInvoice(tx"))
  })

  it("answers both refusals on both progress routes", () => {
    for (const path of ["app/api/v1/orders/[id]/fulfillment-status/route.ts", "app/api/v1/warehouse/orders/[id]/progress/route.ts"]) {
      const source = read(path)
      expect(source, path).toContain('case "stock-short":')
      expect(source, path).toContain('case "no-stock-warehouse":')
    }
  })

  it("never deletes or updates a movement from the application", () => {
    for (const path of sources) {
      const source = read(path)
      expect(source.includes("delete(stockMovements)") || source.includes("update(stockMovements)"), path).toBe(false)
    }
  })

  it("writes warehouse stock only through lib/server/warehouse-stock.ts", () => {
    const writers = sources.filter((path) => /(insert|update|delete)\(warehouseStock\)/.test(read(path)))
    expect(writers).toEqual(["lib/server/warehouse-stock.ts"])
  })
})

describe("per-warehouse stock: what customers are shown", () => {
  it.each([
    "app/api/v1/branch/inventory/route.ts",
    "lib/server/order-desk-catalogue.ts",
  ])("%s shows the branch's own availability", (path) => {
    expect(read(path)).toContain("loadBranchAvailableStock(")
  })

  it("the group storefront shows the least any selected branch can order", () => {
    expect(read("lib/server/group-order-catalog.ts")).toContain("loadLeastAvailableStock(")
  })

  it.each([
    "app/api/v1/admin/global-inventory/route.ts",
    "app/api/v1/analytics/products/catalog-performance/route.ts",
    "app/api/v1/branches/[id]/export/route.ts",
    "lib/server/warehouse-catalog.ts",
  ])("%s lists the stock through productStockDisplaySql", (path) => {
    const source = read(path)
    expect(source).toContain("productStockDisplaySql()")
    expect(source).not.toMatch(/stockQuantity:\s*globalProducts\.stockQuantity,/)
  })
})
