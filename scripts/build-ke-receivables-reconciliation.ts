#!/usr/bin/env tsx

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import * as XLSX from "xlsx"

type Row = Record<string, any>

const SOURCE_INPUT = resolve(process.argv[2] || "updatedReports/ke-receivables-reconciliation-2026-08-06/match-source.json")
const CANDIDATE_INPUT = resolve(process.argv[3] || "updatedReports/ke-receivables-reconciliation-2026-08-06/candidate-analysis.json")
const OUTPUT_DIR = resolve(process.argv[4] || "updatedReports/ke-receivables-reconciliation-2026-08-06")
const JSON_OUTPUT = resolve(OUTPUT_DIR, "reconciliation.json")
const MARKDOWN_OUTPUT = resolve(OUTPUT_DIR, "summary.md")
const EXCEL_OUTPUT = resolve(OUTPUT_DIR, "k-electric-receivables-reconciliation.xlsx")

function money(cents: unknown): number | null {
  const value = Number(cents)
  return Number.isFinite(value) ? value / 100 : null
}

function normalize(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function dateDifferenceBucket(days: number): string {
  const absolute = Math.abs(days)
  if (absolute === 0) return "Same date"
  if (absolute <= 3) return "1-3 days"
  if (absolute <= 7) return "4-7 days"
  if (absolute <= 14) return "8-14 days"
  return "15+ days"
}

function confidenceRule(candidate: Row, margin: number, level: "HIGH" | "PROBABLE" | "POSSIBLE"): boolean {
  if (!candidate) return false
  const dateDifference = Math.abs(Number(candidate.dateDifferenceDays))
  if (level === "HIGH") {
    return margin >= 0.04
      && dateDifference <= 45
      && (
        candidate.score >= 0.74
        || (candidate.financialScore >= 0.999 && candidate.itemScore >= 0.65)
        || (candidate.financialScore >= 0.999 && candidate.addressScore >= 0.75 && dateDifference <= 5)
        || (candidate.itemScore >= 0.75 && margin >= 0.08)
      )
  }
  if (level === "PROBABLE") {
    return margin >= 0.03
      && (
        candidate.score >= 0.68
        || (candidate.financialScore >= 0.995 && candidate.itemScore >= 0.58)
        || (candidate.financialScore >= 0.995 && candidate.addressScore >= 0.75 && dateDifference <= 10)
      )
  }
  return margin >= 0.02
    && (
      candidate.score >= 0.64
      || (candidate.financialScore >= 0.99 && candidate.itemScore >= 0.55)
      || (candidate.financialScore >= 0.99 && candidate.addressScore >= 0.75 && dateDifference <= 15)
    )
}

function assignOneToOne(assessment: Row[]) {
  const remaining = new Map<string, Row[]>(assessment.map((entry) => [entry.invoiceNumber, entry.candidates ?? []]))
  const usedOrders = new Set<string>()
  const assigned: Row[] = []
  const phases: Array<{ key: "HIGH" | "PROBABLE" | "POSSIBLE"; label: string; review: string }> = [
    { key: "HIGH", label: "HIGH CONFIDENCE", review: "No identity review normally required; review listed field differences." },
    { key: "PROBABLE", label: "PROBABLE - REVIEW", review: "Confirm invoice/order identity before operational use." },
    { key: "POSSIBLE", label: "POSSIBLE - MANUAL REVIEW", review: "Treat only as a suggested candidate; manual evidence is required." },
  ]
  for (const phase of phases) {
    for (;;) {
      const rows: Row[] = []
      const byOrder = new Map<string, Row[]>()
      for (const [invoiceNumber, candidates] of remaining) {
        const available = candidates.filter((candidate) => !usedOrders.has(candidate.tid)).sort((a, b) => b.score - a.score)
        if (!available.length) continue
        const row = {
          invoiceNumber,
          best: available[0],
          second: available[1] ?? null,
          margin: available[0].score - (available[1]?.score ?? 0),
        }
        rows.push(row)
        const group = byOrder.get(row.best.tid) ?? []
        group.push(row)
        byOrder.set(row.best.tid, group)
      }
      for (const group of byOrder.values()) group.sort((left, right) => right.best.score - left.best.score)
      const accepted = rows
        .filter((row) => byOrder.get(row.best.tid)?.[0]?.invoiceNumber === row.invoiceNumber)
        .filter((row) => confidenceRule(row.best, row.margin, phase.key))
        .sort((left, right) => right.best.score - left.best.score)
      if (!accepted.length) break
      let changed = false
      for (const row of accepted) {
        if (!remaining.has(row.invoiceNumber) || usedOrders.has(row.best.tid)) continue
        remaining.delete(row.invoiceNumber)
        usedOrders.add(row.best.tid)
        assigned.push({
          ...row,
          confidence: phase.label,
          reviewGuidance: phase.review,
        })
        changed = true
      }
      if (!changed) break
    }
  }
  return { assigned, remaining, usedOrders }
}

function addSheet(
  workbook: XLSX.WorkBook,
  name: string,
  rows: Row[],
  options: { money?: string[]; percent?: string[]; widths?: Record<string, number> } = {},
) {
  const safeRows = rows.length ? rows : [{ Notice: "No rows" }]
  const headers = Object.keys(safeRows[0])
  const worksheet = XLSX.utils.json_to_sheet(safeRows, { header: headers })
  worksheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: safeRows.length, c: headers.length - 1 } }) }
  worksheet["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" } as any
  worksheet["!cols"] = headers.map((header) => ({
    wch: options.widths?.[header] ?? Math.min(52, Math.max(12, header.length + 2, ...safeRows.slice(0, 400).map((row) => String(row[header] ?? "").length + 2))),
  }))
  const formats = new Map<string, string>()
  for (const header of options.money ?? []) formats.set(header, "#,##0.00;[Red]-#,##0.00")
  for (const header of options.percent ?? []) formats.set(header, "0.0%")
  for (const [header, format] of formats) {
    const column = headers.indexOf(header)
    if (column < 0) continue
    for (let row = 1; row <= safeRows.length; row += 1) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: column })]
      if (cell && cell.t === "n") cell.z = format
    }
  }
  XLSX.utils.book_append_sheet(workbook, worksheet, name)
}

function main() {
  const source = JSON.parse(readFileSync(SOURCE_INPUT, "utf8")) as Row
  const candidateAnalysis = JSON.parse(readFileSync(CANDIDATE_INPUT, "utf8")) as Row
  const invoices = source.workbook.invoices as Row[]
  const orders = source.database.orders as Row[]
  const invoiceByNumber = new Map(invoices.map((invoice) => [invoice.invoiceNumber, invoice]))
  const orderByTid = new Map(orders.map((order) => [order.tid, order]))
  const { assigned, remaining, usedOrders } = assignOneToOne(candidateAnalysis.assessment as Row[])
  const assignedByInvoice = new Map(assigned.map((row) => [row.invoiceNumber, row]))
  const high = assigned.filter((row) => row.confidence === "HIGH CONFIDENCE")
  const probable = assigned.filter((row) => row.confidence === "PROBABLE - REVIEW")
  const possible = assigned.filter((row) => row.confidence === "POSSIBLE - MANUAL REVIEW")
  const unresolvedInvoices = invoices.filter((invoice) => !assignedByInvoice.has(invoice.invoiceNumber))
  const unassignedOrders = orders.filter((order) => !usedOrders.has(order.tid))
  if (assigned.length + unresolvedInvoices.length !== invoices.length) throw new Error("Invoice population reconciliation failed")
  if (assigned.length + unassignedOrders.length !== orders.length) throw new Error("Database order population reconciliation failed")
  if (new Set(assigned.map((row) => row.best.tid)).size !== assigned.length) throw new Error("Assigned order IDs are not one-to-one")

  const matchRows = assigned.map((assignment) => {
    const invoice = invoiceByNumber.get(assignment.invoiceNumber)!
    const order = orderByTid.get(assignment.best.tid)!
    const amountDifferenceCents = invoice.totalCents - order.subtotalCents
    const status = order.status === "REFUNDED" ? "Refunded" : order.fulfillmentStatus === "DELIVERED" ? "Delivered" : `${order.status}/${order.fulfillmentStatus}`
    const differences: string[] = []
    if (Math.abs(amountDifferenceCents) > 100) differences.push("Invoice total vs DB subtotal")
    if (Math.abs(assignment.best.dateDifferenceDays) > 7) differences.push("Date over 7 days")
    if (invoice.lineCount !== order.lineCount) differences.push("Line count")
    if (invoice.quantity !== order.quantity) differences.push("Quantity / pack convention")
    if (assignment.best.addressScore < 0.5) differences.push("Weak address/user/branch evidence")
    return {
      "Match Confidence": assignment.confidence,
      "Review Required": assignment.confidence === "HIGH CONFIDENCE" ? (differences.length ? "Field review" : "No") : "Yes",
      "Warehouse Invoice": invoice.invoiceNumber,
      "Warehouse Invoice Date": invoice.date,
      "OneFlowe Transaction ID": order.tid,
      "Legacy Order ID": order.legacyOrderId,
      "Database Order ID": order.databaseOrderId,
      "Database Order Date": order.date,
      "Invoice Minus Order Days": assignment.best.dateDifferenceDays,
      "Database Branch": order.branchName,
      "Database User": order.creatorFullName,
      "Database Status": status,
      "Warehouse Total with Tax (PKR)": money(invoice.totalCents),
      "Database Item Subtotal (PKR)": money(order.subtotalCents),
      "Invoice - DB Subtotal (PKR)": money(amountDifferenceCents),
      "Database Tax (PKR)": money(order.taxCents),
      "Database Grand Total (PKR)": money(order.totalCents),
      "Warehouse Lines": invoice.lineCount,
      "Database Lines": order.lineCount,
      "Warehouse Quantity": invoice.quantity,
      "Database Quantity": order.quantity,
      "Overall Match Score": round(assignment.best.score),
      "Next Candidate Margin": round(assignment.margin),
      "Item Score": round(assignment.best.itemScore),
      "Product Name Score": round(assignment.best.productNameScore),
      "Line Amount Score": round(assignment.best.lineAmountScore),
      "Address/User/Branch Score": round(assignment.best.addressScore),
      "Financial Score": round(assignment.best.financialScore),
      "Fields to Review": differences.join(", "),
      "Shipping Address": invoice.shippingAddress,
    }
  }).sort((left, right) => String(left["Warehouse Invoice Date"]).localeCompare(String(right["Warehouse Invoice Date"])) || String(left["Warehouse Invoice"]).localeCompare(String(right["Warehouse Invoice"])))

  const lineRows: Row[] = []
  for (const assignment of assigned) {
    for (const match of assignment.best.itemMatches ?? []) {
      lineRows.push({
        "Match Confidence": assignment.confidence,
        "Warehouse Invoice": assignment.invoiceNumber,
        "OneFlowe Transaction ID": assignment.best.tid,
        "Warehouse Product": match.warehouseItem,
        "Database Product": match.databaseItem,
        "Warehouse Quantity": match.warehouseQuantity,
        "Database Quantity": match.databaseQuantity,
        "Warehouse Line Total with Tax (PKR)": money(match.warehouseLineTotalCents),
        "Database Line Subtotal (PKR)": money(match.databaseLineTotalCents),
        "Line Amount Difference (PKR)": money(match.warehouseLineTotalCents - match.databaseLineTotalCents),
        "Line Match Score": round(match.score),
        "Product Name Score": round(match.productNameScore),
        "Quantity Score": round(match.quantityScore),
        "Line Amount Score": round(match.lineAmountScore),
      })
    }
  }

  const unresolvedRows = unresolvedInvoices.map((invoice) => {
    const original = (candidateAnalysis.assessment as Row[]).find((row) => row.invoiceNumber === invoice.invoiceNumber)
    const available = (original?.candidates ?? []).filter((candidate: Row) => !usedOrders.has(candidate.tid))
    const top = available[0] ?? original?.candidates?.[0] ?? null
    const second = available[1] ?? original?.candidates?.[1] ?? null
    let reason = "No plausible candidate inside the 45-day, 2x-total, and line-count gates"
    if (top) {
      reason = top.score < 0.64
        ? "Top candidate evidence is too weak"
        : "Candidate is ambiguous, conflicts with a stronger one-to-one match, or misses confidence margins"
    }
    return {
      "Warehouse Invoice": invoice.invoiceNumber,
      "Invoice Date": invoice.date,
      "Total with Tax (PKR)": money(invoice.totalCents),
      Lines: invoice.lineCount,
      Quantity: invoice.quantity,
      "Shipping Address": invoice.shippingAddress,
      "Resolution Status": "UNRESOLVED",
      Reason: reason,
      "Top Candidate": top?.tid ?? "",
      "Top Candidate Date": top?.databaseDate ?? "",
      "Top Candidate Branch": top?.databaseBranch ?? "",
      "Top Score": top ? round(top.score) : null,
      "Top Date Difference Days": top?.dateDifferenceDays ?? null,
      "Top Candidate DB Subtotal (PKR)": top ? money(top.databaseSubtotalCents) : null,
      "Second Candidate": second?.tid ?? "",
      "Second Score": second ? round(second.score) : null,
    }
  }).sort((left, right) => String(left["Invoice Date"]).localeCompare(String(right["Invoice Date"])) || String(left["Warehouse Invoice"]).localeCompare(String(right["Warehouse Invoice"])))

  const unassignedOrderRows = unassignedOrders.map((order) => ({
    "OneFlowe Transaction ID": order.tid,
    "Legacy Order ID": order.legacyOrderId,
    "Database Order ID": order.databaseOrderId,
    "Order Date": order.date,
    Branch: order.branchName,
    User: order.creatorFullName,
    Status: order.status,
    "Fulfillment Status": order.fulfillmentStatus,
    "Subtotal (PKR)": money(order.subtotalCents),
    "Tax (PKR)": money(order.taxCents),
    "Grand Total (PKR)": money(order.totalCents),
    Lines: order.lineCount,
    Quantity: order.quantity,
    "Comparison Status": "NO ONE-TO-ONE INVOICE ASSIGNED",
  })).sort((left, right) => String(left["Order Date"]).localeCompare(String(right["Order Date"])) || String(left["OneFlowe Transaction ID"]).localeCompare(String(right["OneFlowe Transaction ID"])))

  const overviewRows = invoices.map((invoice) => {
    const assignment = assignedByInvoice.get(invoice.invoiceNumber)
    const match = assignment ? matchRows.find((row) => row["Warehouse Invoice"] === invoice.invoiceNumber) : null
    return {
      "Warehouse Invoice": invoice.invoiceNumber,
      "Invoice Date": invoice.date,
      "Warehouse Total with Tax (PKR)": money(invoice.totalCents),
      "Warehouse Lines": invoice.lineCount,
      "Warehouse Quantity": invoice.quantity,
      "Comparison Result": assignment?.confidence ?? "UNRESOLVED",
      "OneFlowe Transaction ID": assignment?.best.tid ?? "",
      "Database Order Date": assignment?.best.databaseDate ?? "",
      "Database Branch": assignment?.best.databaseBranch ?? "",
      "Database User": assignment?.best.databaseCreator ?? "",
      "Invoice - DB Subtotal (PKR)": match?.["Invoice - DB Subtotal (PKR)"] ?? null,
      "Fields to Review": match?.["Fields to Review"] ?? "Invoice/order identity unresolved",
    }
  })

  const productGroups = new Map<string, Row>()
  for (const assignment of high) {
    for (const match of assignment.best.itemMatches ?? []) {
      const key = `${normalize(match.warehouseItem)}|${normalize(match.databaseItem)}`
      const group = productGroups.get(key) ?? {
        warehouseProduct: match.warehouseItem,
        databaseProduct: match.databaseItem,
        occurrences: 0,
        productScore: 0,
        lineAmountScore: 0,
        exactDisplayName: normalize(match.warehouseItem) === normalize(match.databaseItem),
      }
      group.occurrences += 1
      group.productScore += match.productNameScore
      group.lineAmountScore += match.lineAmountScore
      productGroups.set(key, group)
    }
  }
  const productMapRows = [...productGroups.values()].map((group) => ({
    "Warehouse Product": group.warehouseProduct,
    "Database Product": group.databaseProduct,
    "High-Confidence Occurrences": group.occurrences,
    "Average Product Name Score": round(group.productScore / group.occurrences),
    "Average Line Amount Score": round(group.lineAmountScore / group.occurrences),
    "Exact Normalized Display Name": group.exactDisplayName ? "Yes" : "No",
    "Mapping Treatment": group.occurrences >= 2 && group.productScore / group.occurrences >= 0.45
      ? "Observed repeatedly in high-confidence invoice/order matches"
      : "Context-specific; do not use as a global alias without review",
  })).sort((left, right) => Number(right["High-Confidence Occurrences"]) - Number(left["High-Confidence Occurrences"]) || String(left["Warehouse Product"]).localeCompare(String(right["Warehouse Product"])))

  const highMatchRows = matchRows.filter((row) => row["Match Confidence"] === "HIGH CONFIDENCE")
  const reviewMatchRows = matchRows.filter((row) => row["Match Confidence"] !== "HIGH CONFIDENCE")
  const highInvoiceTotalCents = high.reduce((sum, row) => sum + invoiceByNumber.get(row.invoiceNumber)!.totalCents, 0)
  const highDbSubtotalCents = high.reduce((sum, row) => sum + orderByTid.get(row.best.tid)!.subtotalCents, 0)
  const highAmountWithinOneRupee = highMatchRows.filter((row) => Math.abs(Number(row["Invoice - DB Subtotal (PKR)"])) <= 1).length
  const highSameOrSevenDays = highMatchRows.filter((row) => Math.abs(Number(row["Invoice Minus Order Days"])) <= 7).length
  const dateBuckets = new Map<string, number>()
  for (const row of highMatchRows) {
    const bucket = dateDifferenceBucket(Number(row["Invoice Minus Order Days"]))
    dateBuckets.set(bucket, (dateBuckets.get(bucket) ?? 0) + 1)
  }

  const summaryRows: Row[] = [
    { Section: "Scope", Metric: "Warehouse source", Value: basename(source.input), Notes: "Corrected receivables workbook supplied by the user." },
    { Section: "Scope", Metric: "Database mode", Value: "Production read-only", Notes: "K-Electric organization ID 10; database changes: 0." },
    { Section: "Population", Metric: "Warehouse invoices", Value: invoices.length, Notes: "One TOTAL row excluded and independently reconciled." },
    { Section: "Population", Metric: "Warehouse item rows", Value: invoices.reduce((sum, invoice) => sum + invoice.lineCount, 0), Notes: "All K-ELECTRIC LIMITED detail rows." },
    { Section: "Population", Metric: "Current OneFlowe orders", Value: orders.length, Notes: "Current K-Electric order population at the read-only snapshot." },
    { Section: "Matching", Metric: "High-confidence one-to-one matches", Value: high.length, Notes: "Strong multi-signal and one-to-one evidence." },
    { Section: "Matching", Metric: "Probable matches requiring review", Value: probable.length, Notes: "Suggested identity; confirm before operational use." },
    { Section: "Matching", Metric: "Possible matches requiring manual evidence", Value: possible.length, Notes: "Lowest accepted suggestion tier." },
    { Section: "Matching", Metric: "Unresolved warehouse invoices", Value: unresolvedInvoices.length, Notes: "No safe one-to-one assignment was forced." },
    { Section: "Matching", Metric: "OneFlowe orders without an assigned invoice", Value: unassignedOrders.length, Notes: "May include true database-only orders and counterparts of unresolved invoices." },
    { Section: "High-confidence controls", Metric: "Invoice total within PKR 1 of DB item subtotal", Value: `${highAmountWithinOneRupee}/${high.length}`, Notes: "Warehouse Total with Tax compared with OneFlowe item subtotal." },
    { Section: "High-confidence controls", Metric: "Invoice date within 7 days of DB order", Value: `${highSameOrSevenDays}/${high.length}`, Notes: "Positive values mean the warehouse invoice is later." },
    { Section: "High-confidence controls", Metric: "Matched warehouse value (PKR)", Value: highInvoiceTotalCents / 100, Notes: "High-confidence invoices only." },
    { Section: "High-confidence controls", Metric: "Matched DB item subtotal (PKR)", Value: highDbSubtotalCents / 100, Notes: "High-confidence orders only." },
    { Section: "High-confidence controls", Metric: "Aggregate invoice minus DB subtotal (PKR)", Value: (highInvoiceTotalCents - highDbSubtotalCents) / 100, Notes: "Review individual outliers; aggregate netting can hide offsets." },
    { Section: "Warehouse control", Metric: "Footer quantity", Value: source.workbook.footer.quantity, Notes: "Matches calculated detail quantity." },
    { Section: "Warehouse control", Metric: "Footer subtotal before tax (PKR)", Value: source.workbook.footer.subtotalCents / 100, Notes: "Matches calculated detail subtotal." },
    { Section: "Warehouse control", Metric: "Footer total with tax (PKR)", Value: source.workbook.footer.totalCents / 100, Notes: "Matches calculated detail total." },
    ...[...dateBuckets].map(([bucket, count]) => ({ Section: "High-confidence date distribution", Metric: bucket, Value: count, Notes: "Absolute invoice/order date difference." })),
  ]

  const actionRows: Row[] = [
    ...reviewMatchRows.map((row) => ({
      Priority: row["Match Confidence"] === "PROBABLE - REVIEW" ? "High" : "Highest",
      "Action Type": "Confirm suggested invoice/order identity",
      "Warehouse Invoice": row["Warehouse Invoice"],
      "OneFlowe Transaction ID": row["OneFlowe Transaction ID"],
      "Invoice Date": row["Warehouse Invoice Date"],
      "Order Date": row["Database Order Date"],
      Branch: row["Database Branch"],
      "Amount Difference (PKR)": row["Invoice - DB Subtotal (PKR)"],
      Evidence: `score ${row["Overall Match Score"]}; margin ${row["Next Candidate Margin"]}; ${row["Fields to Review"] || "no major field difference"}`,
      "Review Status": "Open",
      Owner: "",
      Notes: "",
    })),
    ...unresolvedRows.map((row) => ({
      Priority: "Highest",
      "Action Type": "Resolve unmatched warehouse invoice",
      "Warehouse Invoice": row["Warehouse Invoice"],
      "OneFlowe Transaction ID": row["Top Candidate"],
      "Invoice Date": row["Invoice Date"],
      "Order Date": row["Top Candidate Date"],
      Branch: row["Top Candidate Branch"],
      "Amount Difference (PKR)": row["Top Candidate DB Subtotal (PKR)"] == null ? null : Number(row["Total with Tax (PKR)"]) - Number(row["Top Candidate DB Subtotal (PKR)"]),
      Evidence: row.Reason,
      "Review Status": "Open",
      Owner: "",
      Notes: "",
    })),
  ]

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "production read-only",
    databaseChanges: 0,
    input: source.input,
    organization: source.organization,
    summary: {
      warehouseInvoices: invoices.length,
      warehouseItemRows: invoices.reduce((sum, invoice) => sum + invoice.lineCount, 0),
      warehouseQuantity: source.workbook.calculated.quantity,
      warehouseSubtotalCents: source.workbook.calculated.subtotalCents,
      warehouseTaxCents: source.workbook.calculated.taxCents,
      warehouseTotalCents: source.workbook.calculated.totalCents,
      databaseOrders: orders.length,
      databaseItemRows: source.database.itemCount,
      databaseQuantity: orders.reduce((sum, order) => sum + order.quantity, 0),
      databaseSubtotalCents: source.database.subtotalCents,
      databaseTaxCents: source.database.taxCents,
      databaseTotalCents: source.database.totalCents,
      highConfidenceMatches: high.length,
      probableMatches: probable.length,
      possibleMatches: possible.length,
      unresolvedWarehouseInvoices: unresolvedInvoices.length,
      unassignedDatabaseOrders: unassignedOrders.length,
      highAmountWithinOneRupee,
      highInvoiceDateWithinSevenDays: highSameOrSevenDays,
      highMatchedWarehouseTotalCents: highInvoiceTotalCents,
      highMatchedDatabaseSubtotalCents: highDbSubtotalCents,
    },
    assignments: assigned.map((row) => ({
      confidence: row.confidence,
      invoiceNumber: row.invoiceNumber,
      tid: row.best.tid,
      score: row.best.score,
      margin: row.margin,
      dateDifferenceDays: row.best.dateDifferenceDays,
      itemScore: row.best.itemScore,
      addressScore: row.best.addressScore,
      financialScore: row.best.financialScore,
    })),
    unresolvedInvoices: unresolvedRows,
    unassignedOrders: unassignedOrderRows,
  }

  const markdown = `# K-Electric receivables vs OneFlowe reconciliation

Generated: ${report.generatedAt}

Mode: production read-only; database changes: 0.

## Population

- Warehouse receivables: ${invoices.length} invoices, ${report.summary.warehouseItemRows} item rows, PKR ${(report.summary.warehouseTotalCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} including tax.
- Current OneFlowe K-Electric data: ${orders.length} orders and ${report.summary.databaseItemRows} item rows.

## One-to-one matching result

- High confidence: ${high.length}
- Probable, review required: ${probable.length}
- Possible, manual evidence required: ${possible.length}
- Unresolved warehouse invoices: ${unresolvedInvoices.length}
- OneFlowe orders without an assigned invoice: ${unassignedOrders.length}

High-confidence controls: ${highAmountWithinOneRupee}/${high.length} invoice totals are within PKR 1 of the matched database item subtotal, and ${highSameOrSevenDays}/${high.length} invoice dates are within seven days of the order date.

The Excel tracker contains the complete invoice/order mapping, alternatives for unresolved invoices, line-item comparisons, and product-name correspondences. Probable and possible matches are suggestions, not confirmed identities.
`

  const workbook = XLSX.utils.book_new()
  workbook.Props = {
    Title: "K-Electric Receivables Reconciliation",
    Subject: "Warehouse receivables versus OneFlowe K-Electric orders",
    Author: "OneFlowe",
    CreatedDate: new Date(report.generatedAt),
  }
  const commonMoney = [
    "Warehouse Total with Tax (PKR)",
    "Database Item Subtotal (PKR)",
    "Invoice - DB Subtotal (PKR)",
    "Database Tax (PKR)",
    "Database Grand Total (PKR)",
  ]
  addSheet(workbook, "Summary", summaryRows, { money: ["Value"], widths: { Section: 32, Metric: 48, Value: 24, Notes: 72 } })
  addSheet(workbook, "Action Items", actionRows, { money: ["Amount Difference (PKR)"], widths: { "Action Type": 38, Evidence: 70, Notes: 42 } })
  addSheet(workbook, "All Invoices", overviewRows, { money: ["Warehouse Total with Tax (PKR)", "Invoice - DB Subtotal (PKR)"], widths: { "Fields to Review": 52 } })
  addSheet(workbook, "High Confidence", highMatchRows, { money: commonMoney, percent: ["Overall Match Score", "Next Candidate Margin", "Item Score", "Product Name Score", "Line Amount Score", "Address/User/Branch Score", "Financial Score"], widths: { "Fields to Review": 48, "Shipping Address": 68 } })
  addSheet(workbook, "Review Matches", reviewMatchRows, { money: commonMoney, percent: ["Overall Match Score", "Next Candidate Margin", "Item Score", "Product Name Score", "Line Amount Score", "Address/User/Branch Score", "Financial Score"], widths: { "Fields to Review": 48, "Shipping Address": 68 } })
  addSheet(workbook, "Unresolved Invoices", unresolvedRows, { money: ["Total with Tax (PKR)", "Top Candidate DB Subtotal (PKR)"], percent: ["Top Score", "Second Score"], widths: { "Shipping Address": 68, Reason: 70 } })
  addSheet(workbook, "Unassigned DB Orders", unassignedOrderRows, { money: ["Subtotal (PKR)", "Tax (PKR)", "Grand Total (PKR)"] })
  addSheet(workbook, "Line Comparisons", lineRows, { money: ["Warehouse Line Total with Tax (PKR)", "Database Line Subtotal (PKR)", "Line Amount Difference (PKR)"], percent: ["Line Match Score", "Product Name Score", "Quantity Score", "Line Amount Score"], widths: { "Warehouse Product": 44, "Database Product": 52 } })
  addSheet(workbook, "Product Name Map", productMapRows, { percent: ["Average Product Name Score", "Average Line Amount Score"], widths: { "Warehouse Product": 52, "Database Product": 58, "Mapping Treatment": 68 } })

  mkdirSync(OUTPUT_DIR, { recursive: true })
  writeFileSync(JSON_OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  writeFileSync(MARKDOWN_OUTPUT, markdown, "utf8")
  XLSX.writeFile(workbook, EXCEL_OUTPUT, { bookType: "xlsx", compression: true, cellStyles: true })

  const validation = XLSX.readFile(EXCEL_OUTPUT)
  const expectedSheets = ["Summary", "Action Items", "All Invoices", "High Confidence", "Review Matches", "Unresolved Invoices", "Unassigned DB Orders", "Line Comparisons", "Product Name Map"]
  if (JSON.stringify(validation.SheetNames) !== JSON.stringify(expectedSheets)) throw new Error("Output workbook sheet validation failed")
  const allInvoiceValidation = XLSX.utils.sheet_to_json(validation.Sheets["All Invoices"], { defval: null })
  if (allInvoiceValidation.length !== invoices.length) throw new Error("Output workbook invoice count validation failed")

  console.log(JSON.stringify({
    jsonOutput: JSON_OUTPUT,
    markdownOutput: MARKDOWN_OUTPUT,
    excelOutput: EXCEL_OUTPUT,
    sheets: validation.SheetNames,
    ...report.summary,
    actionItems: actionRows.length,
    lineComparisons: lineRows.length,
    productNamePairs: productMapRows.length,
    databaseChanges: 0,
  }, null, 2))
}

main()
