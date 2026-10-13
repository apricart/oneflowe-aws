import { describe, expect, it } from "vitest"

import {
  WAREHOUSE_CATALOG_PAGE_SIZE_DEFAULT,
  WAREHOUSE_CATALOG_PAGE_SIZE_MAX,
  WAREHOUSE_LOW_STOCK_THRESHOLD,
  buildWarehouseCatalogCategories,
  isLowStock,
  parseWarehouseCatalogQuery,
  warehouseCatalogCategoryLabels,
} from "@/lib/warehouse-catalog"

const parse = (query: string) => parseWarehouseCatalogQuery(new URLSearchParams(query))

describe("the catalogue query string", () => {
  it("defaults to active products, first page, no category", () => {
    expect(parse("")).toEqual({
      ok: true,
      value: { status: "active", search: "", categoryId: null, subcategoryId: null, page: 1, limit: WAREHOUSE_CATALOG_PAGE_SIZE_DEFAULT },
    })
  })

  it("reads every filter and bounds the page size", () => {
    expect(parse("status=ALL&q=%20rice%20&categoryId=3&subcategoryId=17&page=2&limit=9999")).toEqual({
      ok: true,
      value: { status: "all", search: "rice", categoryId: 3, subcategoryId: 17, page: 2, limit: WAREHOUSE_CATALOG_PAGE_SIZE_MAX },
    })
  })

  it("treats an empty category as no filter", () => {
    expect(parse("categoryId=&subcategoryId=")).toMatchObject({ ok: true, value: { categoryId: null, subcategoryId: null } })
  })

  it("falls back to the first page for a malformed page number", () => {
    expect(parse("page=0&limit=-5")).toMatchObject({ ok: true, value: { page: 1, limit: WAREHOUSE_CATALOG_PAGE_SIZE_DEFAULT } })
  })

  it.each([
    // A price is not a filter the warehouse may name, nor is anything else unlisted.
    ["a price key", "basePrice=1"],
    ["an unknown key", "organizationId=4"],
    ["an unknown status", "status=deleted"],
    ["a long search", `q=${"x".repeat(101)}`],
    ["a zero category", "categoryId=0"],
    ["a negative category", "categoryId=-3"],
    ["a non-numeric subcategory", "subcategoryId=abc"],
    ["a fractional subcategory", "subcategoryId=1.5"],
    ["an oversized id", "categoryId=12345678901"],
  ])("refuses %s", (_label, query) => {
    expect(parse(query).ok).toBe(false)
  })
})

describe("a product's category labels", () => {
  it("names the parent as the category and the row itself as the subcategory", () => {
    expect(warehouseCatalogCategoryLabels({ name: "Tea", parentId: 1, parentName: "Beverages" }))
      .toEqual({ category: "Beverages", subcategory: "Tea" })
  })

  it("files a product under a top-level category with no subcategory", () => {
    expect(warehouseCatalogCategoryLabels({ name: "Stationery", parentId: null, parentName: null }))
      .toEqual({ category: "Stationery", subcategory: null })
  })

  it("keeps the subcategory when its parent row is gone", () => {
    expect(warehouseCatalogCategoryLabels({ name: "Tea", parentId: 9, parentName: null }))
      .toEqual({ category: null, subcategory: "Tea" })
  })

  it("is empty for an uncategorised product", () => {
    expect(warehouseCatalogCategoryLabels({ name: null, parentId: null, parentName: null }))
      .toEqual({ category: null, subcategory: null })
  })
})

describe("the category filter list", () => {
  it("groups subcategories under their parents, sorted by name, once each", () => {
    expect(buildWarehouseCatalogCategories([
      { id: 12, name: "Tea", parentId: 1, parentName: "Beverages" },
      { id: 11, name: "Coffee", parentId: 1, parentName: "Beverages" },
      { id: 12, name: "Tea", parentId: 1, parentName: "Beverages" },
      { id: 21, name: "Pens", parentId: 2, parentName: "Accessories" },
      { id: 3, name: "Cleaning", parentId: null, parentName: null },
    ])).toEqual([
      { id: 2, name: "Accessories", subcategories: [{ id: 21, name: "Pens" }] },
      { id: 1, name: "Beverages", subcategories: [{ id: 11, name: "Coffee" }, { id: 12, name: "Tea" }] },
      { id: 3, name: "Cleaning", subcategories: [] },
    ])
  })

  it("leaves out a subcategory whose parent is gone, which no category filter could reach", () => {
    expect(buildWarehouseCatalogCategories([{ id: 12, name: "Tea", parentId: 9, parentName: null }])).toEqual([])
  })

  it("is empty for an empty catalogue", () => {
    expect(buildWarehouseCatalogCategories([])).toEqual([])
  })
})

describe("running low", () => {
  it("is at or below the threshold", () => {
    expect(isLowStock(WAREHOUSE_LOW_STOCK_THRESHOLD)).toBe(true)
    expect(isLowStock(0)).toBe(true)
    expect(isLowStock(WAREHOUSE_LOW_STOCK_THRESHOLD + 0.001)).toBe(false)
  })
})
