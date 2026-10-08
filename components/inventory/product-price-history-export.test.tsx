import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ProductPriceHistoryPoint } from "@/lib/product-price-history"

const mocks = vi.hoisted(() => ({
  jsonToSheet: vi.fn((_rows: Record<string, unknown>[], _options: { header: string[] }) => ({})),
  bookNew: vi.fn(() => ({})),
  appendSheet: vi.fn(),
  writeFile: vi.fn((_workbook: object, _filename: string) => undefined),
  pdfText: vi.fn(),
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
    text(...args: unknown[]) { mocks.pdfText(...args) }
    save(filename: string) { mocks.pdfSave(filename) }
  },
}))
vi.mock("jspdf-autotable", () => ({ default: mocks.autoTable }))

import { ProductPriceHistoryExport } from "./product-price-history-export"

const points: ProductPriceHistoryPoint[] = [
  {
    id: 2, changedAt: "2026-09-23T12:32:00.000Z", previousPriceCents: 19_500, priceCents: 15_500,
    scope: "BRANCH", changeType: "BACKFILLED_ORDER_PRICE", source: "ORDER_BACKFILL",
    organizationId: 10, organizationName: "K-Electric Limited", groupId: 1, groupName: "Distribution Group",
    branchId: 4, branchName: "=HYPERLINK(\"x\")",
  },
  {
    id: 1, changedAt: "2026-09-21T07:22:00.000Z", previousPriceCents: 15_500, priceCents: 19_500,
    scope: "BRANCH", changeType: "BACKFILLED_ORDER_PRICE", source: "ORDER_BACKFILL",
    organizationId: 10, organizationName: "K-Electric Limited", groupId: 2, groupName: "Enabling Group",
    branchId: 5, branchName: "KE HOUSE",
  },
]

const product = { productCode: "PRD-007", name: "Sugar (01 KG)" }

function choose(format: "CSV" | "Excel" | "PDF") {
  fireEvent.keyDown(screen.getByRole("button", { name: "Export" }), { key: "Enter" })
  fireEvent.click(screen.getByRole("menuitem", { name: format }))
}

describe("ProductPriceHistoryExport", () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("is disabled when the table has no records", () => {
    render(<ProductPriceHistoryExport product={product} points={[]} scopeDescription="All time" />)
    expect(screen.getByRole("button", { name: "Export" })).toHaveProperty("disabled", true)
  })

  it.each([["Excel", "xlsx"], ["CSV", "csv"]] as const)("downloads every table record as %s", (label, extension) => {
    render(<ProductPriceHistoryExport product={product} points={points} scopeDescription="All time" />)
    choose(label)

    const [rows, options] = mocks.jsonToSheet.mock.calls[0]
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row["New price (PKR)"])).toEqual([155, 195])
    expect(options.header[0]).toBe("Changed (PKT)")
    expect(mocks.writeFile.mock.calls[0][1]).toMatch(new RegExp(String.raw`^price-history-PRD-007-\d{4}-\d{2}-\d{2}\.${extension}$`))
  })

  it("neutralizes formula-like text in spreadsheet cells", () => {
    render(<ProductPriceHistoryExport product={product} points={points} scopeDescription="All time" />)
    choose("Excel")
    expect(mocks.jsonToSheet.mock.calls[0][0][0].Branch).toBe("'=HYPERLINK(\"x\")")
  })

  it("downloads a PDF with the filters it was taken under", () => {
    render(<ProductPriceHistoryExport product={product} points={points} scopeDescription="Last 12 months · K-Electric Limited" />)
    choose("PDF")

    const { head, body } = mocks.autoTable.mock.calls[0][1]
    expect(head[0][0]).toBe("Changed (PKT)")
    expect(body).toHaveLength(2)
    expect(body[0][0]).toBe("2026-09-23 17:32")
    expect(mocks.pdfText).toHaveBeenCalledWith("Last 12 months · K-Electric Limited", 14, 32)
    expect(mocks.pdfSave.mock.calls[0][0]).toMatch(/^price-history-PRD-007-.*\.pdf$/)
  })
})
