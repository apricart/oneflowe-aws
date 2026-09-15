import { describe, expect, it } from "vitest"

import { SIDE_BY_SIDE_PANELS, panelsForFocus } from "./executive-analytics"
import {
  EMPTY_PANEL_NOTE,
  SUMMARY_SHEET_NAME,
  buildSideBySideWorkbookData,
  excelSheetName,
  getSideBySideExportFilename,
  isSideBySideExportReady,
  metricColumnHeader,
  type SideBySideExportContext,
  type SideBySidePanelResponse,
  type SideBySidePanelSnapshot,
} from "./executive-side-by-side-export"

const byId = (id: string) => {
  const panel = SIDE_BY_SIDE_PANELS.find((entry) => entry.id === id)
  if (!panel) throw new Error(`no panel ${id}`)
  return panel
}

const rankResponse = (overrides: Partial<SideBySidePanelResponse> = {}): SideBySidePanelResponse => ({
  rows: [
    { key: "186", label: "A4 Paper", value: 1_250_050, previousValue: 1_000_000, changePct: 25.005, orderCount: 12, share: 62.5, cumulativeShare: 62.5 },
    { key: "187", label: "=Toner", value: 750_000, previousValue: 0, changePct: null, orderCount: 3, share: 37.5, cumulativeShare: 100 },
  ],
  series: [],
  periods: [],
  format: "currency",
  label: "Procurement Value",
  formula: "SUM(...)",
  mode: "rank",
  concentrationEligible: true,
  quantityUnit: { selected: null },
  ...overrides,
})

const seriesResponse = (overrides: Partial<SideBySidePanelResponse> = {}): SideBySidePanelResponse => ({
  rows: [],
  series: [
    { key: "u1", label: "Ahmed", points: [{ period: "2026-07", value: 100_00 }, { period: "2026-08", value: 200_00 }, { period: "2026-09", value: 50_00 }] },
    // Sana has no August: the gap must stay a gap, not shift September left.
    { key: "u2", label: "Sana", points: [{ period: "2026-07", value: 10_00 }, { period: "2026-09", value: 30_00 }] },
  ],
  periods: ["2026-07", "2026-08", "2026-09"],
  format: "currency",
  label: "Procurement Value",
  formula: "SUM(...)",
  mode: "series",
  concentrationEligible: true,
  quantityUnit: { selected: null },
  ...overrides,
})

const loaded = (response: SideBySidePanelResponse): SideBySidePanelSnapshot => ({ response, loading: false, error: null })

const context = (overrides: Partial<SideBySideExportContext> = {}): SideBySideExportContext => ({
  startDate: "2026-07-01",
  endDate: "2026-09-12",
  measure: "amount",
  metricLabel: "Procurement Value",
  metricFormula: "SUM(order.totalCents - order.refundAmountCents) over revenue-eligible orders",
  organizations: [],
  branches: ["North Zone"],
  categories: [],
  products: [],
  requesters: [],
  unit: null,
  exportedAt: new Date("2026-09-14T10:30:00.000Z"),
  ...overrides,
})

/** Every snapshot the default six-panel screen holds, all answered. */
function defaultSnapshots(): Record<string, SideBySidePanelSnapshot> {
  return {
    "by-product": loaded(rankResponse()),
    "by-requester": loaded(rankResponse()),
    "by-branch": loaded(rankResponse()),
    "by-month": loaded(rankResponse({
      rows: [
        { key: "2026-07", label: "Jul 2026", value: 500_00, previousValue: 0, changePct: null, orderCount: 4, share: 50, cumulativeShare: 50 },
        { key: "2026-08", label: "Aug 2026", value: 500_00, previousValue: 0, changePct: null, orderCount: 4, share: 50, cumulativeShare: 100 },
      ],
    })),
    "requesters-over-months": loaded(seriesResponse()),
    "products-over-months": loaded(seriesResponse()),
  }
}

describe("excelSheetName", () => {
  it("strips the characters Excel refuses and keeps within 31 characters", () => {
    expect(excelSheetName("By product")).toBe("By product")
    expect(excelSheetName("Spend: North/South [Q3]?*\\")).toBe("Spend North South Q3")
    expect(excelSheetName("A".repeat(40))).toHaveLength(31)
    expect(excelSheetName("   ")).toBe("Sheet")
  })

  it("suffixes a collision, case-insensitively, without overflowing the limit", () => {
    expect(excelSheetName("By month", ["by month"])).toBe("By month (2)")
    expect(excelSheetName("By month", ["By month", "By month (2)"])).toBe("By month (3)")
    const long = "B".repeat(31)
    expect(excelSheetName(long, [long])).toHaveLength(31)
    expect(excelSheetName(long, [long]).endsWith(" (2)")).toBe(true)
  })
})

describe("metricColumnHeader", () => {
  it("names the currency, or the unit of measure when one is selected", () => {
    expect(metricColumnHeader("Procurement Value", "currency", null)).toBe("Procurement Value (PKR)")
    expect(metricColumnHeader("Quantity", "quantity", "Ream")).toBe("Quantity (Ream)")
    expect(metricColumnHeader("Quantity", "quantity", null)).toBe("Quantity")
  })
})

describe("buildSideBySideWorkbookData", () => {
  it("writes the summary first, then one sheet per panel in registry order", () => {
    const panels = panelsForFocus(0)
    const sheets = buildSideBySideWorkbookData(panels, defaultSnapshots(), context())
    expect(sheets.map((sheet) => sheet.name)).toEqual([
      SUMMARY_SHEET_NAME, "By product", "By requester", "By branch", "By month", "Requesters over months", "Products over months",
    ])
  })

  it("names the filters in effect on the summary, with an index of the panel sheets", () => {
    const panels = panelsForFocus(1)
    const [summary] = buildSideBySideWorkbookData(panels, {}, context({
      products: ["A4 Paper"],
      requesters: ["Ahmed", "Sana"],
      organizations: ["K-Electric"],
      categories: ["Stationery"],
      unit: "Ream",
      measure: "quantity",
      metricLabel: "Quantity",
    }))
    expect(summary.columns).toEqual(["Field", "Value"])
    const field = (name: string) => summary.rows.find((row) => row[0] === name)?.[1]
    expect(field("Subject")).toBe("A4 Paper")
    expect(field("Measured by")).toBe("Quantity (Quantity)")
    expect(field("Period")).toBe("2026-07-01 to 2026-09-12")
    expect(field("Organizations")).toBe("K-Electric")
    expect(field("Branches")).toBe("North Zone")
    expect(field("Categories")).toBe("Stationery")
    expect(field("Unit of measure")).toBe("Ream")
    expect(field("Products in focus")).toBe("A4 Paper")
    expect(field("Requesters compared")).toBe("Ahmed, Sana")
    expect(field("Exported at")).toBe("2026-09-14 10:30:00 UTC")
    expect(field("Day-by-day consumption")).toBe("On which days was this product actually consumed?")
    expect(summary.rows.some((row) => row[0] === "By product")).toBe(false)
  })

  it("says All where no filter is set, and describes several products by count", () => {
    const [summary] = buildSideBySideWorkbookData([], {}, context({ branches: [], products: ["A", "B", "C"] }))
    const field = (name: string) => summary.rows.find((row) => row[0] === name)?.[1]
    expect(field("Subject")).toBe("3 products")
    expect(field("Organizations")).toBe("All")
    expect(field("Branches")).toBe("All")
    expect(field("Unit of measure")).toBe("Not selected")
    expect(field("Requesters compared")).toBe("All requesters (top ranked)")
  })

  it("writes a ranked panel in rupees with rank, share, prior period, change and orders", () => {
    const [, product] = buildSideBySideWorkbookData([byId("by-product")], { "by-product": loaded(rankResponse()) }, context())
    expect(product.columns).toEqual([
      "Rank", "Product", "Procurement Value (PKR)", "Share %", "Cumulative share %",
      "Previous period Procurement Value (PKR)", "Change %", "Orders",
    ])
    expect(product.rows).toEqual([
      [1, "A4 Paper", 12500.5, 62.5, 62.5, 10000, 25.01, 12],
      [2, "=Toner", 7500, 37.5, 100, 0, null, 3],
    ])
    expect(product.columnWidths).toHaveLength(product.columns.length)
  })

  it("carries the unit into the header and leaves quantities as they are", () => {
    const response = rankResponse({
      format: "quantity",
      label: "Quantity",
      quantityUnit: { selected: "Ream" },
      concentrationEligible: false,
      rows: [{ key: "7", label: "North", value: 42.333, previousValue: 40, changePct: 5.8325, orderCount: 2, share: 0, cumulativeShare: 0 }],
    })
    const [, branch] = buildSideBySideWorkbookData([byId("by-branch")], { "by-branch": loaded(response) }, context())
    expect(branch.columns).toEqual(["Rank", "Branch", "Quantity (Ream)", "Previous period Quantity (Ream)", "Change %", "Orders"])
    expect(branch.rows).toEqual([[1, "North", 42.33, 40, 5.83, 2]])
  })

  it("omits the prior-period columns on the month panel, which has no prior window", () => {
    const snapshots = defaultSnapshots()
    const [, month] = buildSideBySideWorkbookData([byId("by-month")], snapshots, context())
    expect(month.columns).toEqual(["Rank", "Month", "Procurement Value (PKR)", "Share %", "Cumulative share %", "Orders"])
    expect(month.rows[0]).toEqual([1, "Jul 2026", 500, 50, 50, 4])
  })

  it("writes a trend panel one column per period, aligned by period, with a total", () => {
    const [, trend] = buildSideBySideWorkbookData(
      [byId("requesters-over-months")],
      { "requesters-over-months": loaded(seriesResponse()) },
      context(),
    )
    expect(trend.columns).toEqual(["Requester", "2026-07", "2026-08", "2026-09", "Total Procurement Value (PKR)"])
    expect(trend.rows).toEqual([
      ["Ahmed", 100, 200, 50, 350],
      ["Sana", 10, 0, 30, 40],
    ])
  })

  it("writes the screen's message for a blocked, empty, failed or unanswered panel", () => {
    const blocked = rankResponse({ rows: [], blocked: { reason: "unit-conflict", message: "Quantity cannot be totalled across Litre, Ream." } })
    const sheets = buildSideBySideWorkbookData(
      [byId("by-product"), byId("by-branch"), byId("by-requester"), byId("by-month"), byId("requesters-over-months")],
      {
        "by-product": loaded(blocked),
        "by-branch": loaded(rankResponse({ rows: [] })),
        "by-requester": { response: null, loading: false, error: "This comparison could not be loaded." },
        "by-month": { response: null, loading: true, error: null },
        "requesters-over-months": loaded(seriesResponse({ series: [] })),
      },
      context(),
    )
    const note = (name: string) => {
      const sheet = sheets.find((entry) => entry.name === name)
      expect(sheet?.columns).toEqual(["Note"])
      return sheet?.rows[0][0]
    }
    expect(note("By product")).toBe("Quantity cannot be totalled across Litre, Ream.")
    expect(note("By branch")).toBe(EMPTY_PANEL_NOTE)
    expect(note("By requester")).toBe("This comparison could not be loaded.")
    expect(note("By month")).toBe("This comparison had not loaded when the report was downloaded.")
    expect(note("Requesters over months")).toBe(EMPTY_PANEL_NOTE)
  })
})

describe("isSideBySideExportReady", () => {
  it("is ready only once every panel on screen has answered or failed", () => {
    const panels = panelsForFocus(0)
    const snapshots = defaultSnapshots()
    expect(isSideBySideExportReady(panels, snapshots)).toBe(true)

    expect(isSideBySideExportReady(panels, { ...snapshots, "by-branch": { response: null, loading: true, error: null } })).toBe(false)
    expect(isSideBySideExportReady(panels, { ...snapshots, "by-branch": { response: null, loading: false, error: null } })).toBe(false)
    expect(isSideBySideExportReady(panels, { ...snapshots, "by-branch": { response: null, loading: false, error: "failed" } })).toBe(true)

    const { "by-month": _omitted, ...missingOne } = snapshots
    expect(isSideBySideExportReady(panels, missingOne)).toBe(false)
    expect(isSideBySideExportReady([], snapshots)).toBe(false)
  })
})

describe("getSideBySideExportFilename", () => {
  it("is built from the measure and the ISO period only", () => {
    expect(getSideBySideExportFilename({ measure: "amount", startDate: "2026-07-01", endDate: "2026-09-12" }))
      .toBe("compare-side-by-side-amount-2026-07-01-to-2026-09-12.xlsx")
    expect(getSideBySideExportFilename({ measure: "quantity", startDate: "../x", endDate: "" }))
      .toBe("compare-side-by-side-quantity-unknown-to-unknown.xlsx")
  })
})
