import { describe, expect, it } from "vitest"

import {
  ASSIGNED_EXPORT_HEADERS,
  NOT_ASSIGNED_EXPORT_HEADERS,
  buildAssignedExportRows,
  buildNotAssignedExportRows,
  organizationProductsExportFileName,
  organizationProductsFilterDescription,
} from "./organization-products-export"

describe("buildNotAssignedExportRows", () => {
  it("writes one row per product with every header, base price as PKR", () => {
    const [row] = buildNotAssignedExportRows([{
      productCode: "PRD-007", name: "Sugar (01 KG)", parentCategoryName: "Grocery", categoryName: "Staples",
      basePrice: 15_550, unit: "kg",
    }])
    expect(Object.keys(row)).toEqual([...NOT_ASSIGNED_EXPORT_HEADERS])
    expect(row).toEqual({
      "Product code": "PRD-007",
      "Product": "Sugar (01 KG)",
      "Category": "Grocery",
      "Subcategory": "Staples",
      "Base price (PKR)": 155.5,
      "Unit": "kg",
    })
  })

  it("labels a product with no category as Uncategorized, as the table does", () => {
    const [row] = buildNotAssignedExportRows([{ productCode: "P", name: "N", basePrice: 0, unit: "pc" }])
    expect(row).toMatchObject({ Category: "Uncategorized", Subcategory: "Uncategorized", "Base price (PKR)": 0 })
  })

  it("keeps the caller's order and count", () => {
    const rows = buildNotAssignedExportRows([
      { productCode: "B", name: "B", basePrice: 100, unit: "pc" },
      { productCode: "A", name: "A", basePrice: 100, unit: "pc" },
    ])
    expect(rows.map((r) => r["Product code"])).toEqual(["B", "A"])
    expect(buildNotAssignedExportRows([])).toEqual([])
  })
})

describe("buildAssignedExportRows", () => {
  const base = {
    productCode: "PRD-001", productName: "Rice", customName: null, parentCategoryName: "Grocery",
    categoryName: "Grains", customPrice: 25_000, globalStatus: "active",
  }

  it("writes one row per assignment with every header", () => {
    const [row] = buildAssignedExportRows([base])
    expect(Object.keys(row)).toEqual([...ASSIGNED_EXPORT_HEADERS])
    expect(row).toEqual({
      "Product code": "PRD-001",
      "Product": "Rice",
      "Category": "Grocery",
      "Subcategory": "Grains",
      "Custom price (PKR)": 250,
      "Status": "Active",
    })
  })

  it("prefers the organization's own name for the product", () => {
    expect(buildAssignedExportRows([{ ...base, customName: "Basmati Rice" }])[0].Product).toBe("Basmati Rice")
  })

  it("leaves the price blank when none is set, null or zero", () => {
    for (const customPrice of [null, 0]) {
      expect(buildAssignedExportRows([{ ...base, customPrice }])[0]["Custom price (PKR)"]).toBe("")
    }
  })

  it("reads anything but an active global product as Inactive", () => {
    expect(buildAssignedExportRows([{ ...base, globalStatus: "inactive" }])[0].Status).toBe("Inactive")
    expect(buildAssignedExportRows([{ ...base, globalStatus: undefined }])[0].Status).toBe("Inactive")
  })
})

describe("organizationProductsExportFileName", () => {
  it("uses a filesystem-safe organization name, the list and the download date", () => {
    const now = new Date("2026-10-15T08:00:00.000Z")
    expect(organizationProductsExportFileName("Demo Retail Co (DEMO-BURN)", "assigned", "xlsx", now))
      .toBe("organization-products-Demo-Retail-Co-DEMO-BURN-assigned-2026-10-15.xlsx")
    expect(organizationProductsExportFileName("///", "all", "pdf", now))
      .toBe("organization-products-organization-all-2026-10-15.pdf")
  })
})

describe("organizationProductsFilterDescription", () => {
  it("names every filter in force", () => {
    expect(organizationProductsFilterDescription({ search: " rice ", category: "Grocery", subcategory: "Grains" }))
      .toBe('Filters: Search: "rice" · Category: Grocery · Subcategory: Grains')
  })

  it("says so when nothing narrows the list", () => {
    expect(organizationProductsFilterDescription({ search: "  ", category: null })).toBe("Filters: none (all products)")
  })
})
