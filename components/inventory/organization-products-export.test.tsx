import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  jsonToSheet: vi.fn((_rows: Record<string, unknown>[], _options: { header: string[] }) => ({})),
  bookNew: vi.fn(() => ({})),
  appendSheet: vi.fn((_workbook: object, _sheet: object, _name: string) => undefined),
  writeFile: vi.fn((_workbook: object, _filename: string) => undefined),
  pdfText: vi.fn(),
  pdfAddPage: vi.fn(),
  pdfSave: vi.fn((_filename: string) => undefined),
  autoTable: vi.fn((_doc: object, _options: { head: string[][]; body: string[][] }) => undefined),
}))

vi.mock("xlsx", () => ({
  utils: { json_to_sheet: mocks.jsonToSheet, book_new: mocks.bookNew, book_append_sheet: mocks.appendSheet },
  writeFile: mocks.writeFile,
}))
vi.mock("jspdf", () => ({
  default: class {
    setFontSize() {}
    addPage() { mocks.pdfAddPage() }
    text(...args: unknown[]) { mocks.pdfText(...args) }
    save(filename: string) { mocks.pdfSave(filename) }
  },
}))
vi.mock("jspdf-autotable", () => ({ default: mocks.autoTable }))

import { OrganizationProductsExport } from "./organization-products-export"

const notAssigned = [
  { productCode: "PRD-1", name: "=HYPERLINK(\"x\")", parentCategoryName: "Grocery", categoryName: "Staples", basePrice: 15_500, unit: "kg" },
  { productCode: "PRD-2", name: "Salt", basePrice: 5_000, unit: "kg" },
]
const assigned = [
  { productCode: "PRD-3", productName: "Rice", customName: null, customPrice: 25_000, globalStatus: "active" },
]

function renderExport(props: Partial<Parameters<typeof OrganizationProductsExport>[0]> = {}) {
  render(
    <OrganizationProductsExport
      organizationName="Demo Retail Co"
      notAssigned={notAssigned}
      assigned={assigned}
      filterDescription="Filters: none (all products)"
      {...props}
    />,
  )
}

function choose(name: RegExp) {
  fireEvent.keyDown(screen.getByRole("button", { name: "Export" }), { key: "Enter" })
  fireEvent.click(screen.getByRole("menuitem", { name }))
}

describe("OrganizationProductsExport", () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("is disabled when both lists are empty", () => {
    renderExport({ notAssigned: [], assigned: [] })
    expect(screen.getByRole("button", { name: "Export" })).toHaveProperty("disabled", true)
  })

  it("is disabled while the lists are loading", () => {
    renderExport({ disabled: true })
    expect(screen.getByRole("button", { name: "Export" })).toHaveProperty("disabled", true)
  })

  it("downloads the Not Assigned list as Excel, neutralising formula-like text", () => {
    renderExport()
    choose(/^Not Assigned \(2\) — Excel$/)
    expect(mocks.jsonToSheet).toHaveBeenCalledTimes(1)
    const [rows, options] = mocks.jsonToSheet.mock.calls[0]
    expect(rows).toHaveLength(2)
    expect(rows[0].Product).toBe("'=HYPERLINK(\"x\")")
    expect(rows[0]["Base price (PKR)"]).toBe(155)
    expect(options.header).toContain("Base price (PKR)")
    expect(mocks.appendSheet.mock.calls[0][2]).toBe("Not Assigned")
    expect(mocks.writeFile.mock.calls[0][1]).toMatch(/^organization-products-Demo-Retail-Co-not-assigned-\d{4}-\d{2}-\d{2}\.xlsx$/)
  })

  it("downloads the Assigned list as Excel", () => {
    renderExport()
    choose(/^Assigned \(1\) — Excel$/)
    const [rows] = mocks.jsonToSheet.mock.calls[0]
    expect(rows).toEqual([expect.objectContaining({ Product: "Rice", "Custom price (PKR)": 250, Status: "Active" })])
    expect(mocks.appendSheet.mock.calls[0][2]).toBe("Assigned")
  })

  it("downloads both lists as one workbook with a sheet each", () => {
    renderExport()
    choose(/^Both lists \(3\) — Excel$/)
    expect(mocks.appendSheet.mock.calls.map((call) => call[2])).toEqual(["Not Assigned", "Assigned"])
    expect(mocks.writeFile.mock.calls[0][1]).toMatch(/-all-.*\.xlsx$/)
  })

  it("downloads a PDF with the filters it was taken under", () => {
    renderExport({ filterDescription: "Filters: Search: \"rice\"" })
    choose(/^Assigned \(1\) — PDF$/)
    const { head, body } = mocks.autoTable.mock.calls[0][1]
    expect(head[0]).toEqual(["Product code", "Product", "Category", "Subcategory", "Custom price", "Status"])
    expect(body).toHaveLength(1)
    expect(mocks.pdfText).toHaveBeenCalledWith("Filters: Search: \"rice\"", 14, 32)
    expect(mocks.pdfAddPage).not.toHaveBeenCalled()
    expect(mocks.pdfSave.mock.calls[0][0]).toMatch(/-assigned-.*\.pdf$/)
  })

  it("puts each list on its own page when both are exported as PDF", () => {
    renderExport()
    choose(/^Both lists \(3\) — PDF$/)
    expect(mocks.autoTable).toHaveBeenCalledTimes(2)
    expect(mocks.pdfAddPage).toHaveBeenCalledTimes(1)
  })

  it("does not offer a list that is empty", () => {
    renderExport({ assigned: [] })
    fireEvent.keyDown(screen.getByRole("button", { name: "Export" }), { key: "Enter" })
    expect(screen.getByRole("menuitem", { name: /^Assigned \(0\) — Excel$/ }).getAttribute("aria-disabled")).toBe("true")
  })
})
