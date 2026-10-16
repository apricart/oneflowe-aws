import { describe, expect, it } from "vitest"

import { sanitizeSpreadsheetRow } from "@/lib/spreadsheet"
import {
  ORDER_REPORT_EXPORT_COLUMNS,
  buildOrderReportExportRows,
  resolveOrderReportExportColumns,
  resolveOrderReportExportHeaders,
  type OrderReportExportRecord,
} from "@/lib/order-report-export-layout"

const FULL_LAYOUT = [
  "S. No",
  "Order ID",
  "Transaction ID",
  "Initiator",
  "Initiated Date",
  "Approver",
  "Approval Level",
  "Approver Designation",
  "Approved Date",
  "Delivered Date",
  "Fulfiller",
  "Fulfilled Date",
  "Group",
  "Branch",
  "Status",
  "Qty Ordered",
  "Qty Delivered",
  "Qty Refunded",
  "Subtotal",
  "Refund",
  "Net Value",
  "Invoice No",
  "Payment Status",
]

const fulfilledOrder: OrderReportExportRecord = {
  id: 1919,
  tid: "mtmiah8dee1839daa7fb5ed2",
  status: "FULFILLED",
  fulfillmentStatus: "DELIVERED",
  paymentStatus: "UNPAID",
  userName: "Taliya Khan",
  approverName: "Brendon Dias Anthony",
  approverDesignation: "Finance Manager",
  approvalLevel: 2,
  fulfillerName: "Taliya Khan",
  createdAt: "2026-09-04T09:44:00.000Z",
  groupName: "Contact Center",
  branchName: "Credit Policy & Research",
  invoiceNumber: "APR-000047",
  quantityOrdered: 4,
  quantityRefunded: 0,
  subtotalCents: 364831,
  totalCents: 430500,
  refundAmountCents: 0,
}

describe("order report export layout", () => {
  describe("columns", () => {
    it("is the fixed tenant-facing layout, in order", () => {
      expect(resolveOrderReportExportHeaders()).toEqual(FULL_LAYOUT)
    })

    it("renames only the net column for a buying tenant", () => {
      const headers = resolveOrderReportExportHeaders({ isBuyer: true })

      expect(headers).toEqual(FULL_LAYOUT.map((label) => (label === "Net Value" ? "Net Purchased" : label)))
    })

    it("withholds every money column when prices are hidden from the role", () => {
      const headers = resolveOrderReportExportHeaders({ pricesHidden: true })

      expect(headers).not.toContain("Subtotal")
      expect(headers).not.toContain("Refund")
      expect(headers).not.toContain("Net Value")
      expect(headers).not.toContain("Net Purchased")
      expect(headers).toHaveLength(FULL_LAYOUT.length - 3)
    })

    it("keeps the non-money columns intact when prices are hidden", () => {
      const columns = resolveOrderReportExportColumns({ pricesHidden: true })

      expect(columns.map((column) => column.key)).toEqual(
        ORDER_REPORT_EXPORT_COLUMNS.filter((column) => !column.financial).map((column) => column.key),
      )
    })

    it("hides prices for a buyer whose role may not read them", () => {
      // The two options are independent: buying does not re-reveal a hidden price.
      expect(resolveOrderReportExportHeaders({ isBuyer: true, pricesHidden: true })).not.toContain("Net Purchased")
    })
  })

  describe("rows", () => {
    it("reproduces the sample layout for a fulfilled order", () => {
      const [row] = buildOrderReportExportRows([fulfilledOrder])
      const value = (label: string) => row[FULL_LAYOUT.indexOf(label)]

      expect(value("S. No")).toBe(1)
      expect(value("Order ID")).toBe("1919")
      expect(value("Transaction ID")).toBe("mtmiah8dee1839daa7fb5ed2")
      expect(value("Initiator")).toBe("Taliya Khan")
      expect(value("Approver")).toBe("Brendon Dias Anthony")
      expect(value("Approval Level")).toBe("Level 2")
      expect(value("Approver Designation")).toBe("Finance Manager")
      expect(value("Fulfiller")).toBe("Taliya Khan")
      expect(value("Group")).toBe("Contact Center")
      expect(value("Branch")).toBe("Credit Policy & Research")
      expect(value("Status")).toBe("Fulfilled")
      expect(value("Qty Ordered")).toBe(4)
      expect(value("Qty Delivered")).toBe(4)
      expect(value("Qty Refunded")).toBe(0)
      expect(value("Subtotal")).toBe("3648.31")
      expect(value("Refund")).toBe("0.00")
      expect(value("Net Value")).toBe("4305.00")
      expect(value("Invoice No")).toBe("APR-000047")
      // The sample file spells this "Un-Paid"; the application's own label is
      // "Unpaid" (PAYMENT_STATUS_LABELS). The shared helper wins over the
      // sample so the download and the screen never disagree.
      expect(value("Payment Status")).toBe("Unpaid")
    })

    it("numbers rows sequentially across the whole export, not per page", () => {
      const rows = buildOrderReportExportRows([fulfilledOrder, fulfilledOrder, fulfilledOrder])

      expect(rows.map((row) => row[0])).toEqual([1, 2, 3])
    })

    it("leaves a date blank when the order never reached that stage", () => {
      const [row] = buildOrderReportExportRows([fulfilledOrder])

      expect(row[FULL_LAYOUT.indexOf("Approved Date")]).toBe("")
      expect(row[FULL_LAYOUT.indexOf("Delivered Date")]).toBe("")
      expect(row[FULL_LAYOUT.indexOf("Fulfilled Date")]).toBe("")
    })

    it("formats a date that is present", () => {
      const [row] = buildOrderReportExportRows([
        { ...fulfilledOrder, approvedAt: "2026-09-05T00:00:00.000Z" },
      ])

      expect(row[FULL_LAYOUT.indexOf("Approved Date")]).toBe(
        new Date("2026-09-05T00:00:00.000Z").toLocaleDateString(),
      )
    })

    it("leaves a date blank rather than printing Invalid Date", () => {
      const [row] = buildOrderReportExportRows([{ ...fulfilledOrder, approvedAt: "not-a-date" }])

      expect(row[FULL_LAYOUT.indexOf("Approved Date")]).toBe("")
    })

    it("blanks missing text rather than dashing it", () => {
      const [row] = buildOrderReportExportRows([
        { ...fulfilledOrder, approverName: null, approverDesignation: null, approvalLevel: null, fulfillerName: undefined, invoiceNumber: "   " },
      ])

      expect(row[FULL_LAYOUT.indexOf("Approver")]).toBe("")
      expect(row[FULL_LAYOUT.indexOf("Approval Level")]).toBe("")
      expect(row[FULL_LAYOUT.indexOf("Approver Designation")]).toBe("")
      expect(row[FULL_LAYOUT.indexOf("Fulfiller")]).toBe("")
      expect(row[FULL_LAYOUT.indexOf("Invoice No")]).toBe("")
    })

    it("emits nothing the spreadsheet sanitizer has to neutralise", () => {
      // A leading "-" would come back as `'-` in the CSV. No placeholder may
      // look like a formula.
      const rows = buildOrderReportExportRows([
        { ...fulfilledOrder, approverName: null, fulfillerName: null, invoiceNumber: null },
      ])

      for (const cell of rows[0]) {
        expect(sanitizeSpreadsheetRow([cell])[0]).toBe(cell)
      }
    })

    it("nets a refund out of both the quantity delivered and the money", () => {
      const [row] = buildOrderReportExportRows([
        { ...fulfilledOrder, quantityRefunded: 1, refundAmountCents: 107625 },
      ])

      expect(row[FULL_LAYOUT.indexOf("Qty Delivered")]).toBe(3)
      expect(row[FULL_LAYOUT.indexOf("Qty Refunded")]).toBe(1)
      expect(row[FULL_LAYOUT.indexOf("Refund")]).toBe("1076.25")
      expect(row[FULL_LAYOUT.indexOf("Net Value")]).toBe("3228.75")
    })

    it("treats absent quantities and money as zero rather than blank", () => {
      const [row] = buildOrderReportExportRows([{ id: 7, tid: "t7", status: "PENDING" }])

      expect(row[FULL_LAYOUT.indexOf("Qty Ordered")]).toBe(0)
      expect(row[FULL_LAYOUT.indexOf("Qty Delivered")]).toBe(0)
      expect(row[FULL_LAYOUT.indexOf("Subtotal")]).toBe("0.00")
      expect(row[FULL_LAYOUT.indexOf("Net Value")]).toBe("0.00")
    })

    it("drops the money cells, not just the money headers, when prices are hidden", () => {
      const headers = resolveOrderReportExportHeaders({ pricesHidden: true })
      const [row] = buildOrderReportExportRows([fulfilledOrder], { pricesHidden: true })

      expect(row).toHaveLength(headers.length)
      expect(row).not.toContain("3648.31")
      expect(row).not.toContain("4305.00")
      expect(row[headers.indexOf("Invoice No")]).toBe("APR-000047")
    })

    it("returns no rows for an empty export", () => {
      expect(buildOrderReportExportRows([])).toEqual([])
    })
  })
})
