import { describe, expect, it } from "vitest"

import {
  WAREHOUSE_LOW_STOCK_THRESHOLD,
  WAREHOUSE_STOCK_PAGE_SIZE_DEFAULT,
  WAREHOUSE_STOCK_PAGE_SIZE_MAX,
  isLowStock,
  parseWarehouseStockQuery,
} from "@/lib/warehouse-stock"

const parse = (query: string) => parseWarehouseStockQuery(new URLSearchParams(query))

describe("the stock query string", () => {
  it("defaults to active products, first page", () => {
    expect(parse("")).toEqual({
      ok: true,
      value: { status: "active", search: "", lowOnly: false, page: 1, limit: WAREHOUSE_STOCK_PAGE_SIZE_DEFAULT },
    })
  })

  it("reads every filter and bounds the page size", () => {
    expect(parse("status=ALL&q=%20rice%20&low=1&page=2&limit=9999")).toEqual({
      ok: true,
      value: { status: "all", search: "rice", lowOnly: true, page: 2, limit: WAREHOUSE_STOCK_PAGE_SIZE_MAX },
    })
  })

  it.each([
    ["an unknown key", "price=1"],
    ["an unknown status", "status=deleted"],
    ["a long search", `q=${"x".repeat(101)}`],
    ["a bad low flag", "low=true"],
  ])("refuses %s", (_label, query) => {
    expect(parse(query).ok).toBe(false)
  })
})

describe("running low", () => {
  it("is at or below the threshold", () => {
    expect(isLowStock(WAREHOUSE_LOW_STOCK_THRESHOLD)).toBe(true)
    expect(isLowStock(0)).toBe(true)
    expect(isLowStock(WAREHOUSE_LOW_STOCK_THRESHOLD + 0.001)).toBe(false)
  })
})
