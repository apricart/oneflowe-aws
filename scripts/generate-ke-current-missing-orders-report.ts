#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import * as XLSX from "xlsx"

type Row = Record<string, any>

const BASE = resolve("updatedReports/ke-unimported-orders-details-2026-07-23.xlsx")
const SNAPSHOT = resolve("backups/ke-import-state-2026-08-03-post-live-resolved-13-orders.json")
const OMITTED_AUDIT = resolve("updatedReports/ke-omitted-from-updated-exports-7-live-audit-2026-08-03.json")
const OUTPUT = resolve("updatedReports/ke-current-missing-orders-excluding-cancelled-2026-08-03.xlsx")
const SUMMARY_JSON = resolve("updatedReports/ke-current-missing-orders-excluding-cancelled-2026-08-03.json")

function sheetRows(workbook: XLSX.WorkBook, name: string): Row[] {
  return XLSX.utils.sheet_to_json<Row>(workbook.Sheets[name], { defval: null, raw: true })
}

function autoWidth(rows: Row[], headers: string[]): XLSX.ColInfo[] {
  return headers.map((header) => ({ wch: Math.min(70, Math.max(11, header.length + 2, ...rows.slice(0, 500).map((row) => String(row[header] ?? "").length + 2))) }))
}

function addSheet(workbook: XLSX.WorkBook, name: string, rows: Row[], options: { money?: string[]; dates?: string[]; integers?: string[] } = {}) {
  if (!rows.length) throw new Error(`Cannot create empty sheet ${name}`)
  const headers = Object.keys(rows[0])
  const sheet = XLSX.utils.json_to_sheet(rows, { header: headers })
  sheet["!cols"] = autoWidth(rows, headers)
  sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) }
  sheet["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" } as any
  const formats = new Map<string, string>()
  for (const header of options.money ?? []) formats.set(header, "#,##0.00;[Red]-#,##0.00")
  for (const header of options.dates ?? []) formats.set(header, "yyyy-mm-dd hh:mm")
  for (const header of options.integers ?? []) formats.set(header, "0")
  for (const [header, format] of formats) {
    const column = headers.indexOf(header)
    if (column < 0) continue
    for (let row = 1; row <= rows.length; row += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })]
      if (cell && cell.t === "n") cell.z = format
    }
  }
  XLSX.utils.book_append_sheet(workbook, sheet, name)
}

function main() {
  const base = XLSX.readFile(BASE, { cellDates: false })
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Row
  const omittedAudit = JSON.parse(readFileSync(OMITTED_AUDIT, "utf8")) as Row
  const importedIds = new Set((snapshot.legacyOrderImports as Row[]).map((row) => Number(row.legacy_order_id)))
  const allExceptionRows = sheetRows(base, "Unimported Orders")
  const cancelledRows = allExceptionRows.filter((row) => String(row["Current Interpretation"]).trim().toLowerCase() === "cancelled")
  const missingRows = allExceptionRows
    .filter((row) => !importedIds.has(Number(row["Legacy Order ID"])))
    .filter((row) => String(row["Current Interpretation"]).trim().toLowerCase() !== "cancelled")
    .map((row) => {
      const id = Number(row["Legacy Order ID"])
      const isOmittedDraft = String(row["Blocker Code"]) === "OMITTED_FROM_UPDATED_ORDER_EXPORT"
      return {
        ...row,
        "Current Production Status": "NOT IMPORTED",
        "Latest Review": isOmittedDraft
          ? "Live detail returns empty ID 0; no item, checkout, or current open-order record. Likely abandoned/deleted draft."
          : "Still requires the evidence or policy shown in Evidence / Correction Needed.",
        "Safe to Import Now": "NO",
        "Latest Evidence Source": isOmittedDraft ? "ke-omitted-from-updated-exports-7-live-audit-2026-08-03.json" : "Current production ledger + reviewed legacy exports",
      }
    })
    .sort((a, b) => Number(a["Legacy Order ID"]) - Number(b["Legacy Order ID"]))

  const missingIds = new Set(missingRows.map((row) => Number(row["Legacy Order ID"])))
  const itemRows = sheetRows(base, "Order Items").filter((row) => missingIds.has(Number(row["Legacy Order ID"])))
  const refundRows = sheetRows(base, "Refund Details").filter((row) => missingIds.has(Number(row["Legacy Order ID"])))
  const originalGuide = sheetRows(base, "Reason Guide")
  const guideByCode = new Map(originalGuide.map((row) => [String(row["Blocker Code"]), row]))
  const grouped = new Map<string, number[]>()
  for (const row of missingRows) {
    const code = String(row["Blocker Code"])
    grouped.set(code, [...(grouped.get(code) ?? []), Number(row["Legacy Order ID"])])
  }
  const reasonOrder = ["WORKFLOW_NOT_FINAL", "HAS_REFUND_EVIDENCE", "OMITTED_FROM_UPDATED_ORDER_EXPORT", "MISSING_AUTHORITATIVE_ORDER_HEADER", "ZERO_QUANTITY_ITEM_LINES", "NO_ITEM_LINES"]
  const reasonRows = reasonOrder.filter((code) => grouped.has(code)).map((code) => {
    const baseRow = guideByCode.get(code) ?? {}
    const ids = grouped.get(code)!.sort((a, b) => a - b)
    return {
      ...baseRow,
      "Orders": ids.length,
      "Legacy Order IDs": ids.join(", "),
      "Latest Assessment": code === "OMITTED_FROM_UPDATED_ORDER_EXPORT"
        ? "Live APIs now confirm no real detail record, item rows, checkout rows, or open-order match. Retain as excluded abandoned/deleted drafts."
        : "Still unimported after current production-ledger reconciliation.",
    }
  })

  const importedCount = importedIds.size
  const knownCount = 811
  const remainingCount = knownCount - importedCount
  const cancelledRemaining = cancelledRows.filter((row) => !importedIds.has(Number(row["Legacy Order ID"]))).length
  const summaryRows: Row[] = [
    { Metric: "Organization", Value: "K-Electric only (ID 10, code 0001)", Notes: "No other organization is included." },
    { Metric: "Report generated from production snapshot", Value: snapshot.generatedAt, Notes: "Read-only K-Electric post-import snapshot." },
    { Metric: "Known legacy order IDs", Value: knownCount, Notes: "Union established by the prior comprehensive reconciliation." },
    { Metric: "Currently imported legacy order IDs", Value: importedCount, Notes: "Verified from the current K-Electric legacy_order_imports ledger." },
    { Metric: "Currently unimported legacy order IDs", Value: remainingCount, Notes: `${knownCount} known minus ${importedCount} imported.` },
    { Metric: "Cancelled unimported orders excluded", Value: cancelledRemaining, Notes: "Excluded from every detail sheet by user request." },
    { Metric: "Non-cancelled missing orders in this workbook", Value: missingRows.length, Notes: "Every included ID appears exactly once in Missing Orders." },
    { Metric: "Item evidence rows", Value: itemRows.length, Notes: "Only rows for the current 28 missing orders." },
    { Metric: "Refund detail rows", Value: refundRows.length, Notes: "Remaining refund-evidence orders are included; only cancelled orders were excluded." },
    { Metric: "Live-confirmed abandoned/deleted drafts", Value: omittedAudit.summary.orders, Notes: "IDs 1168-1173 and 1184 have no live detail/open-order record." },
    { Metric: "Definition of missing", Value: "Known legacy ID not present in current production import ledger", Notes: "This includes unresolved workflow, refund, header, item-line, and abandoned-draft cases." },
    { Metric: "Safe to bulk import", Value: "NO", Notes: "Each remaining blocker requires its stated evidence or an explicitly reviewed migration policy." },
  ]

  const sourceRows = sheetRows(base, "Source Files")
  sourceRows.push(
    { Source: "Current production snapshot", File: SNAPSHOT, Role: "Authoritative current K-Electric import-ledger state after the latest reviewed batches." },
    { Source: "Live omitted-order audit", File: OMITTED_AUDIT, Role: "Confirms the seven omitted IDs have no live detail, checkout, item, or open-order record." },
    { Source: "Current report", File: OUTPUT, Role: "All currently missing non-cancelled K-Electric legacy orders." },
  )

  if (missingRows.length !== 28 || new Set(missingRows.map((row) => row["Legacy Order ID"])).size !== 28) throw new Error(`Expected 28 unique missing rows, found ${missingRows.length}`)
  if (missingRows.some((row) => importedIds.has(Number(row["Legacy Order ID"])))) throw new Error("Report contains an imported order")
  if (missingRows.some((row) => String(row["Current Interpretation"]).trim().toLowerCase() === "cancelled")) throw new Error("Report contains a cancelled order")
  if (reasonRows.reduce((sum, row) => sum + Number(row.Orders), 0) !== missingRows.length) throw new Error("Reason-guide count mismatch")

  const workbook = XLSX.utils.book_new()
  addSheet(workbook, "Summary", summaryRows)
  addSheet(workbook, "Missing Orders", missingRows, {
    money: ["Reported Subtotal", "Raw Unit Price × Qty", "Raw vs Reported Difference", "Discount", "Service Charges", "Tax", "Grand Total", "Refund Amount", "Refund Tax", "Monthly Budget", "Used Budget", "Remaining Budget"],
    dates: ["Order Date", "Created On", "Last Updated"],
    integers: ["Legacy Order ID", "StatusID", "DeliveryStatus", "Order No", "Transaction No", "Selected Item Lines"],
  })
  addSheet(workbook, "Order Items", itemRows, { money: ["Selected Unit Price", "Selected Line Total", "Raw Unit Price", "Raw Line Total"] })
  addSheet(workbook, "Refund Details", refundRows, { money: ["Refund Amount", "Refund Tax", "Grand Total", "Subtotal", "Tax"] })
  addSheet(workbook, "Reason Guide", reasonRows)
  addSheet(workbook, "Source Files", sourceRows)
  XLSX.writeFile(workbook, OUTPUT, { bookType: "xlsx", compression: true, cellStyles: true })

  const validation = XLSX.readFile(OUTPUT)
  const validationRows = XLSX.utils.sheet_to_json<Row>(validation.Sheets["Missing Orders"], { defval: null })
  if (validationRows.length !== 28 || validation.SheetNames.length !== 6) throw new Error("Workbook validation failed")
  const outputBuffer = readFileSync(OUTPUT)
  const report = {
    generatedAt: new Date().toISOString(), organizationId: 10, organizationCode: "0001",
    knownLegacyOrderIds: knownCount, importedLegacyOrderIds: importedCount, unimportedLegacyOrderIds: remainingCount,
    cancelledExcluded: cancelledRemaining, missingNonCancelledOrders: missingRows.length,
    missingLegacyOrderIds: missingRows.map((row) => Number(row["Legacy Order ID"])),
    reasons: reasonRows.map((row) => ({ code: row["Blocker Code"], count: row.Orders, legacyOrderIds: String(row["Legacy Order IDs"]).split(", ").map(Number) })),
    itemRows: itemRows.length, refundRows: refundRows.length,
    workbook: { path: OUTPUT, bytes: outputBuffer.byteLength, sha256: createHash("sha256").update(outputBuffer).digest("hex"), sheets: validation.SheetNames },
    productionDatabaseChanges: 0,
  }
  writeFileSync(SUMMARY_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log(JSON.stringify({ output: OUTPUT, summaryJson: SUMMARY_JSON, ...report }, null, 2))
}

main()
