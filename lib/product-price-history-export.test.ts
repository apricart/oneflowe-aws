import { describe, expect, it } from "vitest"

import type { ProductPriceHistoryPoint } from "./product-price-history"
import {
  PRODUCT_PRICE_HISTORY_EXPORT_HEADERS,
  buildProductPriceHistoryExportRows,
  karachiTimestamp,
  productPriceHistoryExportFileName,
} from "./product-price-history-export"

const product = { productCode: "PRD-007", name: "Sugar (01 KG)" }

function point(overrides: Partial<ProductPriceHistoryPoint> = {}): ProductPriceHistoryPoint {
  return {
    id: 1,
    changedAt: "2026-09-23T12:32:00.000Z",
    previousPriceCents: 19_500,
    priceCents: 15_500,
    scope: "BRANCH",
    changeType: "BACKFILLED_ORDER_PRICE",
    source: "ORDER_BACKFILL",
    organizationId: 10,
    organizationName: "K-Electric Limited",
    groupId: 1,
    groupName: "Distribution Group",
    branchId: 4,
    branchName: "KEDNA",
    ...overrides,
  }
}

describe("buildProductPriceHistoryExportRows", () => {
  it("writes one row per record with every header, prices as PKR numbers", () => {
    const [row] = buildProductPriceHistoryExportRows(product, [point()])
    expect(Object.keys(row)).toEqual([...PRODUCT_PRICE_HISTORY_EXPORT_HEADERS])
    expect(row).toEqual({
      "Changed (PKT)": "2026-09-23 17:32",
      "Product code": "PRD-007",
      "Product": "Sugar (01 KG)",
      "Previous price (PKR)": 195,
      "New price (PKR)": 155,
      "Change (PKR)": -40,
      "Scope": "Historical branch",
      "Organization": "K-Electric Limited",
      "Group": "Distribution Group",
      "Branch": "KEDNA",
      "Source": "Historical backfill",
    })
  })

  it("keeps the caller's order and count, so the file matches the table", () => {
    const rows = buildProductPriceHistoryExportRows(product, [
      point({ id: 3, changedAt: "2026-09-23T00:00:00.000Z" }),
      point({ id: 2, changedAt: "2026-09-21T00:00:00.000Z" }),
    ])
    expect(rows.map((r) => r["Changed (PKT)"])).toEqual(["2026-09-23 05:00", "2026-09-21 05:00"])
  })

  it("leaves previous price and change blank when no positive previous price is known", () => {
    for (const previousPriceCents of [null, 0]) {
      const [row] = buildProductPriceHistoryExportRows(product, [point({ previousPriceCents })])
      expect(row["Previous price (PKR)"]).toBe("")
      expect(row["Change (PKR)"]).toBe("")
    }
  })

  it("labels a global row as applying to all organizations", () => {
    const [row] = buildProductPriceHistoryExportRows(product, [point({
      scope: "GLOBAL", source: "CATALOG_CHANGE", organizationId: null, organizationName: null,
      groupId: null, groupName: null, branchId: null, branchName: null,
    })])
    expect(row).toMatchObject({ Scope: "Global", Organization: "All organizations", Group: "", Branch: "", Source: "Recorded change" })
  })

  it("keeps paisa without float drift", () => {
    const [row] = buildProductPriceHistoryExportRows(product, [point({ previousPriceCents: 10_010, priceCents: 10_030 })])
    expect(row["Change (PKR)"]).toBe(0.2)
  })

  it("returns nothing for no records", () => {
    expect(buildProductPriceHistoryExportRows(product, [])).toEqual([])
  })
})

describe("karachiTimestamp", () => {
  it("renders Karachi wall-clock time across the UTC day boundary", () => {
    expect(karachiTimestamp("2026-09-30T20:15:00.000Z")).toBe("2026-10-01 01:15")
  })
})

describe("productPriceHistoryExportFileName", () => {
  it("uses a filesystem-safe product code and the download date", () => {
    const now = new Date("2026-10-06T08:00:00.000Z")
    expect(productPriceHistoryExportFileName({ productCode: "PRD--49" }, "xlsx", now)).toBe("price-history-PRD--49-2026-10-06.xlsx")
    expect(productPriceHistoryExportFileName({ productCode: "KE/12 ab" }, "pdf", now)).toBe("price-history-KE-12-ab-2026-10-06.pdf")
    expect(productPriceHistoryExportFileName({ productCode: "///" }, "csv", now)).toBe("price-history-product-2026-10-06.csv")
  })
})
