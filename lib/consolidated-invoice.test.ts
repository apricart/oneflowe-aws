import { describe, expect, it } from "vitest"

import {
  approverLevelOf,
  buildConsolidatedInvoiceRow,
  buildConsolidatedInvoiceRows,
  CONSOLIDATED_INVOICE_MAX_BRANCH_IDS,
  consolidatedInvoiceDigestInput,
  consolidatedInvoiceFileName,
  consolidatedInvoiceFilterNote,
  consolidatedInvoicePeriodLabel,
  consolidatedInvoiceStatement,
  consolidatedInvoiceTitle,
  consolidatedInvoiceTotals,
  daysInclusive,
  formatReportMoney,
  formatReportQuantity,
  karachiToday,
  legacyDateFootnote,
  parseConsolidatedInvoiceQuery,
  taxRateOf,
  type ConsolidatedInvoiceSource,
} from "./consolidated-invoice"
import { canReadConsolidatedInvoiceReport, choosesOrganization } from "./consolidated-invoice-access"

const TODAY = "2026-10-11"
const parse = (query: string) => parseConsolidatedInvoiceQuery(new URLSearchParams(query), TODAY)

const source = (overrides: Partial<ConsolidatedInvoiceSource> = {}): ConsolidatedInvoiceSource => ({
  orderId: 1778,
  invoiceNumber: "UBL-APR-000030",
  date: "2026-08-24",
  orderStatus: "FULFILLED",
  refundAmountCents: null,
  invoiceStatus: "ISSUED",
  paymentStatus: "UNPAID",
  department: "Compliance",
  approver: "Farruk Khalil",
  approvalLevel: null,
  costCenterId: "CC-1",
  quantity: 169,
  creditedQuantity: 0,
  taxRatesBp: [1_800],
  netCents: 14_352_119,
  taxCents: 2_583_381,
  totalCents: 16_935_500,
  creditedNetCents: 0,
  creditedTaxCents: 0,
  creditedTotalCents: 0,
  ...overrides,
})

describe("parseConsolidatedInvoiceQuery — periods", () => {
  it("covers a whole month", () => {
    expect(parse("period=month&month=2026-08")).toMatchObject({ ok: true, query: { from: "2026-08-01", to: "2026-08-31", mode: "invoices" } })
  })

  it("handles a leap February and December", () => {
    expect(parse("period=month&month=2024-02")).toMatchObject({ query: { from: "2024-02-01", to: "2024-02-29" } })
    expect(parse("period=month&month=2025-12")).toMatchObject({ query: { from: "2025-12-01", to: "2025-12-31" } })
  })

  it("stops the current month at today, and refuses a future month", () => {
    expect(parse("period=month&month=2026-10")).toMatchObject({ query: { from: "2026-10-01", to: TODAY } })
    expect(parse("period=month&month=2026-11")).toMatchObject({ ok: false })
  })

  it("takes an inclusive custom range of up to 366 days", () => {
    expect(parse("period=range&from=2026-08-24&to=2026-09-02")).toMatchObject({ ok: true, query: { from: "2026-08-24", to: "2026-09-02" } })
    expect(parse("period=range&from=2026-08-24&to=2026-08-24")).toMatchObject({ ok: true })
    expect(daysInclusive("2025-10-11", "2026-10-11")).toBe(366)
    expect(parse("period=range&from=2025-10-11&to=2026-10-11")).toMatchObject({ ok: true })
    expect(parse("period=range&from=2025-10-10&to=2026-10-11")).toMatchObject({ ok: false })
  })

  it("refuses a backwards, future, unreal or half-given range", () => {
    expect(parse("period=range&from=2026-09-02&to=2026-08-24")).toMatchObject({ ok: false })
    expect(parse("period=range&from=2026-10-01&to=2026-10-12")).toMatchObject({ ok: false })
    expect(parse("period=range&from=2026-02-30&to=2026-03-02")).toMatchObject({ ok: false })
    expect(parse("period=range&from=2026-08-24")).toMatchObject({ ok: false })
    expect(parse("period=month")).toMatchObject({ ok: false })
    expect(parse("period=month&month=2026-13")).toMatchObject({ ok: false })
  })

  it("refuses mixing the two period kinds", () => {
    expect(parse("period=month&month=2026-08&from=2026-08-01")).toMatchObject({ ok: false })
    expect(parse("period=range&month=2026-08&from=2026-08-01&to=2026-08-02")).toMatchObject({ ok: false })
  })
})

describe("parseConsolidatedInvoiceQuery — everything else", () => {
  it("reads the filters", () => {
    expect(parse("period=month&month=2026-08&mode=proformas&organizationId=6&branchIds=3,4&groupId=9&includeCredited=true&sort=total&dir=desc"))
      .toEqual({
        ok: true,
        query: {
          organizationId: 6,
          mode: "proformas",
          from: "2026-08-01",
          to: "2026-08-31",
          branchIds: [3, 4],
          groupId: 9,
          includeCredited: true,
          paymentStatus: null,
          sort: { key: "total", direction: "desc" },
        },
      })
  })

  it("refuses unknown, repeated or malformed parameters instead of ignoring them", () => {
    expect(parse("period=month&month=2026-08&status=PAID")).toMatchObject({ ok: false })
    expect(parse("period=month&month=2026-08&mode=invoices&mode=proformas")).toMatchObject({ ok: false })
    expect(parse("period=month&month=2026-08&branchIds=1,x")).toMatchObject({ ok: false })
    expect(parse("period=month&month=2026-08&branchIds=1,1")).toMatchObject({ ok: false })
    expect(parse("period=month&month=2026-08&sort=price")).toMatchObject({ ok: false })
    expect(parse("period=month&month=2026-08&dir=asc")).toMatchObject({ ok: false })
    expect(parse("period=month&month=2026-08&organizationId=0")).toMatchObject({ ok: false })
  })

  it("filters invoices by payment status, and nothing else", () => {
    expect(parse("period=month&month=2026-08&paymentStatus=PAID")).toMatchObject({ ok: true, query: { paymentStatus: "PAID" } })
    expect(parse("period=month&month=2026-08&mode=invoices&paymentStatus=UNPAID")).toMatchObject({ ok: true, query: { paymentStatus: "UNPAID" } })
    expect(parse("period=month&month=2026-08")).toMatchObject({ ok: true, query: { paymentStatus: null } })
    for (const value of ["paid", "PARTIALLY_PAID", "", "PAID,UNPAID"]) {
      expect(parse(`period=month&month=2026-08&paymentStatus=${value}`)).toMatchObject({ ok: false })
    }
    expect(parse("period=month&month=2026-08&paymentStatus=PAID&paymentStatus=UNPAID")).toMatchObject({ ok: false })
  })

  it("refuses a payment-status filter on proformas, which are never paid", () => {
    expect(parse("period=month&month=2026-08&mode=proformas&paymentStatus=UNPAID")).toEqual({
      ok: false,
      error: "paymentStatus applies to invoices, not proformas",
    })
  })

  it("bounds the branch filter", () => {
    const ids = Array.from({ length: CONSOLIDATED_INVOICE_MAX_BRANCH_IDS + 1 }, (_, index) => index + 1).join(",")
    expect(parse(`period=month&month=2026-08&branchIds=${ids}`)).toMatchObject({ ok: false })
  })
})

describe("a row is its invoice less what has been credited", () => {
  it("copies an uncredited invoice", () => {
    expect(buildConsolidatedInvoiceRow("invoices", source(), 1)).toMatchObject({
      serial: 1,
      invoiceNumber: "UBL-APR-000030",
      invoiceDate: "24 Aug 2026",
      orderStatus: "Fulfilled",
      invoiceStatus: "ISSUED",
      department: "Compliance",
      crc: "CC-1",
      designation: "",
      quantity: 169,
      taxRateLabel: "18%",
      valueExclTaxCents: 14_352_119,
      taxCents: 2_583_381,
      totalCents: 16_935_500,
    })
  })

  it("nets a partial credit, value + tax still adding to the total", () => {
    const row = buildConsolidatedInvoiceRow("invoices", source({
      refundAmountCents: 1_180,
      invoiceStatus: "PARTIALLY_CREDITED",
      creditedQuantity: 1,
      creditedNetCents: 1_000,
      creditedTaxCents: 180,
      creditedTotalCents: 1_180,
    }), 1)
    expect(row).toMatchObject({ quantity: 168, valueExclTaxCents: 14_351_119, taxCents: 2_583_201, totalCents: 16_934_320, orderStatus: "Fulfilled", invoiceStatus: "PARTIALLY_CREDITED" })
    expect(row.valueExclTaxCents + row.taxCents).toBe(row.totalCents)
  })

  it("brings a fully credited invoice to zero, never below", () => {
    const row = buildConsolidatedInvoiceRow("invoices", source({
      orderStatus: "REFUNDED", invoiceStatus: "CREDITED", creditedQuantity: 200,
      creditedNetCents: 14_352_119, creditedTaxCents: 2_583_381, creditedTotalCents: 99_999_999,
    }), 1)
    expect(row).toMatchObject({ quantity: 0, valueExclTaxCents: 0, taxCents: 0, totalCents: 0, invoiceStatus: "CREDITED" })
  })

  it("carries the order's payment status, reading anything but PAID as unpaid", () => {
    expect(buildConsolidatedInvoiceRow("invoices", source({ paymentStatus: "PAID" }), 1).paymentStatus).toBe("PAID")
    expect(buildConsolidatedInvoiceRow("invoices", source({ paymentStatus: "UNPAID" }), 1).paymentStatus).toBe("UNPAID")
    expect(buildConsolidatedInvoiceRow("invoices", source({ paymentStatus: null }), 1).paymentStatus).toBe("UNPAID")
  })

  it("names the level the order was approved at beside the approver, and nothing for an order without one", () => {
    expect(buildConsolidatedInvoiceRow("invoices", source({ approvalLevel: 2 }), 1)).toMatchObject({
      approver: "Farruk Khalil", approverLevel: "Level 2", approvalLevel: 2,
    })
    expect(buildConsolidatedInvoiceRow("proformas", source({ approvalLevel: 1 }), 1).approverLevel).toBe("Level 1")
    expect(buildConsolidatedInvoiceRow("invoices", source(), 1)).toMatchObject({ approverLevel: "", approvalLevel: null })
  })

  it("marks a proforma's number as reserved, or says it comes when the order is processed", () => {
    expect(buildConsolidatedInvoiceRow("proformas", source({ invoiceNumber: "UBL-APR-000040" }), 1).invoiceNumber).toBe("UBL-APR-000040 (when processed)")
    expect(buildConsolidatedInvoiceRow("proformas", source({ invoiceNumber: null }), 1).invoiceNumber).toBe("When processed")
    expect(buildConsolidatedInvoiceRow("invoices", source({ invoiceNumber: null }), 1).invoiceNumber).toBe("—")
  })
})

describe("approverLevelOf", () => {
  it("names only a level the database could hold", () => {
    expect(approverLevelOf(1)).toEqual({ approverLevel: "Level 1", approvalLevel: 1 })
    expect(approverLevelOf(10)).toEqual({ approverLevel: "Level 10", approvalLevel: 10 })
    for (const value of [null, undefined, 0, 11, -1, 1.5, Number.NaN]) {
      expect(approverLevelOf(value)).toEqual({ approverLevel: "", approvalLevel: null })
    }
  })
})

describe("taxRateOf", () => {
  it("names one rate, calls several mixed", () => {
    expect(taxRateOf({ taxRatesBp: [1_800, 1_800], netCents: 1, taxCents: 0 })).toEqual({ label: "18%", bp: 1_800 })
    expect(taxRateOf({ taxRatesBp: [1_750], netCents: 1, taxCents: 0 })).toEqual({ label: "17.5%", bp: 1_750 })
    expect(taxRateOf({ taxRatesBp: [1_800, 500], netCents: 1, taxCents: 0 })).toEqual({ label: "Mixed", bp: null })
  })

  it("infers the rate of an invoice without recorded rates only when its cents reconstruct it", () => {
    expect(taxRateOf({ taxRatesBp: [], netCents: 14_352_119, taxCents: 2_583_381 })).toEqual({ label: "18%", bp: 1_800 })
    expect(taxRateOf({ taxRatesBp: [], netCents: 1_000, taxCents: 0 })).toEqual({ label: "—", bp: null })
  })
})

describe("ordering and totals", () => {
  const rows = buildConsolidatedInvoiceRows("invoices", [
    source({ orderId: 1, invoiceNumber: "A-APR-000001", totalCents: 300, netCents: 300, taxCents: 0, quantity: 1.5 }),
    source({ orderId: 2, invoiceNumber: "A-APR-000002", totalCents: 100, netCents: 100, taxCents: 0, quantity: 2 }),
    source({ orderId: 3, invoiceNumber: "A-APR-000003", totalCents: 200, netCents: 200, taxCents: 0, quantity: 3 }),
  ], { key: "total", direction: "desc" })

  it("sorts as asked and numbers the rows in that order", () => {
    expect(rows.map((row) => [row.serial, row.orderId])).toEqual([[1, 1], [2, 3], [3, 2]])
  })

  it("sorts by approver level, unlevelled orders last", () => {
    const sorted = buildConsolidatedInvoiceRows("invoices", [
      source({ orderId: 1, approvalLevel: null }),
      source({ orderId: 2, approvalLevel: 3 }),
      source({ orderId: 3, approvalLevel: 1 }),
    ], { key: "approverLevel", direction: "asc" })
    expect(sorted.map((row) => row.orderId)).toEqual([3, 2, 1])
  })

  it("keeps the query's order when no sort is asked for", () => {
    const unsorted = buildConsolidatedInvoiceRows("invoices", [source({ orderId: 9 }), source({ orderId: 8 })], null)
    expect(unsorted.map((row) => row.orderId)).toEqual([9, 8])
  })

  it("totals are the column sums in cents", () => {
    expect(consolidatedInvoiceTotals(rows)).toEqual({ orders: 3, quantity: 6.5, valueExclTaxCents: 600, taxCents: 0, totalCents: 600 })
    expect(consolidatedInvoiceTotals([])).toEqual({ orders: 0, quantity: 0, valueExclTaxCents: 0, taxCents: 0, totalCents: 0 })
  })

  it("digests each row's number and total in printed order", () => {
    expect(consolidatedInvoiceDigestInput(rows)).toBe('[["A-APR-000001",300],["A-APR-000003",200],["A-APR-000002",100]]')
  })
})

describe("the document's wording", () => {
  it("titles and describes each mode", () => {
    expect(consolidatedInvoiceTitle("invoices")).toBe("CONSOLIDATED INVOICE")
    expect(consolidatedInvoiceTitle("proformas")).toBe("CONSOLIDATED PROFORMA")
    expect(consolidatedInvoiceStatement("invoices")).toMatch(/Not a separate tax invoice/)
    expect(consolidatedInvoiceStatement("proformas")).toMatch(/no tax invoice has been issued/)
  })

  it("adds the date footnote only to invoices dated before the ledger", () => {
    expect(legacyDateFootnote("invoices", "2026-10-01")).toMatch(/order date/)
    expect(legacyDateFootnote("invoices", "2026-10-11")).toBeNull()
    expect(legacyDateFootnote("proformas", "2026-01-01")).toBeNull()
  })

  it("labels the period and names the file safely", () => {
    expect(consolidatedInvoicePeriodLabel("2026-08-24", "2026-09-02")).toBe("24 Aug 2026 – 02 Sep 2026")
    expect(consolidatedInvoiceFileName("invoices", "UBL_123A", "2026-08-01", "2026-08-31")).toBe("consolidated-invoice-UBL_123A-2026-08-01_2026-08-31.pdf")
    expect(consolidatedInvoiceFileName("proformas", "../x", "2026-08-01", "2026-08-31")).toBe("consolidated-proforma-x-2026-08-01_2026-08-31.pdf")
    expect(consolidatedInvoiceFileName("invoices", "UBL", "2026-08-01", "2026-08-31", "UNPAID")).toBe("consolidated-invoice-UBL-2026-08-01_2026-08-31-unpaid.pdf")
    expect(consolidatedInvoiceFileName("invoices", "UBL", "2026-08-01", "2026-08-31", "PAID", "xlsx")).toBe("consolidated-invoice-UBL-2026-08-01_2026-08-31-paid.xlsx")
    expect(consolidatedInvoiceFileName("proformas", "UBL", "2026-08-01", "2026-08-31", null, "csv")).toBe("consolidated-proforma-UBL-2026-08-01_2026-08-31.csv")
  })

  it("names a payment-status filter on the document, and says nothing without one", () => {
    expect(consolidatedInvoiceFilterNote("UNPAID")).toBe("Unpaid invoices only")
    expect(consolidatedInvoiceFilterNote("PAID")).toBe("Paid invoices only")
    expect(consolidatedInvoiceFilterNote(null)).toBeNull()
  })

  it("formats quantities and money", () => {
    expect(formatReportQuantity(169)).toBe("169")
    expect(formatReportQuantity(12.5)).toBe("12.5")
    expect(formatReportMoney(75_450_000)).toBe("754,500.00")
  })

  it("dates today in Karachi", () => {
    expect(karachiToday(new Date("2026-08-31T19:30:00Z"))).toBe("2026-09-01")
  })
})

describe("access", () => {
  it("is Super Admin and Head Office only", () => {
    expect(canReadConsolidatedInvoiceReport("SUPER_ADMIN")).toBe(true)
    expect(canReadConsolidatedInvoiceReport("HEAD_OFFICE")).toBe(true)
    for (const role of ["BRANCH_ADMIN", "GROUP_USER", "ORDER_PORTAL", "GROUP_ORDER_PORTAL", "VIEWER", "ORDER_DESK", "APRICART_EXECUTIVE", "WAREHOUSE", undefined]) {
      expect(canReadConsolidatedInvoiceReport(role)).toBe(false)
    }
    expect(choosesOrganization("SUPER_ADMIN")).toBe(true)
    expect(choosesOrganization("HEAD_OFFICE")).toBe(false)
  })
})
