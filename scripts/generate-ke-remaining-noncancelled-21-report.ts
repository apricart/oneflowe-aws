#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import * as XLSX from "xlsx"

type Row = Record<string, any>

const PRIOR_REPORT = resolve("updatedReports/ke-missing-orders-live-detail-reviewed-excluding-cancelled-2026-08-04.xlsx")
const POST_SNAPSHOT = resolve("backups/ke-import-state-2026-08-04-post-reviewed-7-orders.json")
const VALIDATION = resolve("updatedReports/ke-current-missing-safe-candidates-2026-08-04/current-production-post-validation.json")
const OUTPUT = resolve("updatedReports/ke-remaining-non-cancelled-orders-21-2026-08-04.xlsx")
const OUTPUT_JSON = resolve("updatedReports/ke-remaining-non-cancelled-orders-21-2026-08-04.json")
const IMPORTED_IDS = [250, 520, 765, 1164, 1165, 1177, 1187]
const EXPECTED_REMAINING_IDS = [41, 43, 44, 51, 53, 60, 87, 173, 174, 177, 192, 415, 1100, 1155, 1168, 1169, 1170, 1171, 1172, 1173, 1184]

function rows(workbook: XLSX.WorkBook, sheet: string): Row[] {
  return XLSX.utils.sheet_to_json<Row>(workbook.Sheets[sheet], { defval: null, raw: true })
}

function autoWidth(data: Row[], headers: string[]): XLSX.ColInfo[] {
  return headers.map((header) => ({ wch: Math.min(70, Math.max(11, header.length + 2, ...data.slice(0, 500).map((row) => String(row[header] ?? "").length + 2))) }))
}

function addSheet(workbook: XLSX.WorkBook, name: string, data: Row[], options: { money?: string[]; integers?: string[] } = {}) {
  const safeData = data.length ? data : [{ Notice: "No rows" }]
  const headers = Object.keys(safeData[0])
  const sheet = XLSX.utils.json_to_sheet(safeData, { header: headers })
  sheet["!cols"] = autoWidth(safeData, headers)
  sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: safeData.length, c: headers.length - 1 } }) }
  sheet["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" } as any
  const formats = new Map<string, string>()
  for (const header of options.money ?? []) formats.set(header, "#,##0.00;[Red]-#,##0.00")
  for (const header of options.integers ?? []) formats.set(header, "0")
  for (const [header, format] of formats) {
    const column = headers.indexOf(header)
    if (column < 0) continue
    for (let row = 1; row <= safeData.length; row += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })]
      if (cell?.t === "n") cell.z = format
    }
  }
  XLSX.utils.book_append_sheet(workbook, sheet, name)
}

function finalBlocker(id: number): string {
  if ([41, 51, 53, 60, 87].includes(id)) return "NOT_DELIVERED_OUT_FOR_DELIVERY"
  if (id === 44) return "NON_FINAL_WITH_UNSUPPORTED_REFUND"
  if (id === 43) return "UNSUPPORTED_TAX_REFUND"
  if ([173, 174, 177].includes(id)) return "CORRUPTED_REFUND_STATE"
  if ([192, 1100].includes(id)) return "MISSING_TARGET_PRODUCT_MAPPING"
  if (id === 415) return "NO_CHECKOUT_AND_STATUS_NOT_FINAL"
  if (id === 1155) return "IN_PROCESS"
  if ([1168, 1169, 1170, 1171, 1172, 1173, 1184].includes(id)) return "NO_LIVE_ORDER_RECORD"
  throw new Error(`No final blocker for ${id}`)
}

function main() {
  const prior = XLSX.readFile(PRIOR_REPORT, { cellDates: false })
  const snapshot = JSON.parse(readFileSync(POST_SNAPSHOT, "utf8")) as Row
  const validation = JSON.parse(readFileSync(VALIDATION, "utf8")) as Row
  if (validation.status !== "PASS") throw new Error("Seven-order production validation did not pass")
  const importedLedgerIds = new Set((snapshot.legacyOrderImports as Row[]).map((row) => Number(row.legacy_order_id)))
  const priorAssessments = rows(prior, "Order Assessment")
  const remaining = priorAssessments
    .filter((row) => !importedLedgerIds.has(Number(row["Legacy Order ID"])))
    .map((row) => ({
      ...row,
      "Final Blocker Code": finalBlocker(Number(row["Legacy Order ID"])),
      "Current Production Status": "NOT IMPORTED",
      "Safe to Import Immediately": "NO",
      "Current Reconciliation": "Still missing after the reviewed seven-order production import.",
    }))
    .sort((a, b) => Number(a["Legacy Order ID"]) - Number(b["Legacy Order ID"]))
  const remainingIds = remaining.map((row) => Number(row["Legacy Order ID"]))
  if (JSON.stringify(remainingIds) !== JSON.stringify(EXPECTED_REMAINING_IDS)) throw new Error(`Remaining IDs mismatch: ${remainingIds.join(", ")}`)

  const remainingSet = new Set(remainingIds)
  const itemRows = rows(prior, "Live Detail Items").filter((row) => remainingSet.has(Number(row["Legacy Order ID"])))
  const refundRows = rows(prior, "Refund Evidence").filter((row) => remainingSet.has(Number(row["Legacy Order ID"])))
  const blockerGroups = new Map<string, number[]>()
  for (const row of remaining) {
    const code = String(row["Final Blocker Code"])
    blockerGroups.set(code, [...(blockerGroups.get(code) ?? []), Number(row["Legacy Order ID"])])
  }
  const blockerDescriptions: Record<string, string> = {
    NOT_DELIVERED_OUT_FOR_DELIVERY: "Individual detail remains Out For Delivery; only explicit Partial was authorized as delivered.",
    NON_FINAL_WITH_UNSUPPORTED_REFUND: "Order is non-final and contains item and tax refund activity that cannot use the current refund path.",
    UNSUPPORTED_TAX_REFUND: "Item refund reconciles, but the tax refund is not represented safely by the current target refund schema.",
    CORRUPTED_REFUND_STATE: "Negative refund quantities/prices and item totals conflict with the checkout refund amount.",
    MISSING_TARGET_PRODUCT_MAPPING: "Refund evidence reconciles, but at least one item lacks a safe K-Electric target product mapping.",
    NO_CHECKOUT_AND_STATUS_NOT_FINAL: "Items exist, but there is no checkout total and the authoritative order status is not final.",
    IN_PROCESS: "Individual detail remains In Process and was not authorized as delivered.",
    NO_LIVE_ORDER_RECORD: "Individual detail returns the default empty ID 0 record; likely an abandoned or deleted draft.",
  }
  const reasonRows = [...blockerGroups.entries()].map(([code, ids]) => ({
    "Final Blocker Code": code,
    Orders: ids.length,
    "Legacy Order IDs": ids.sort((a, b) => a - b).join(", "),
    Explanation: blockerDescriptions[code],
    "Import Decision": "DO NOT IMPORT until the blocker is resolved and a fresh production preflight passes.",
  })).sort((a, b) => String(a["Final Blocker Code"]).localeCompare(String(b["Final Blocker Code"])))

  const importByLegacyId = new Map((snapshot.legacyOrderImports as Row[]).map((row) => [Number(row.legacy_order_id), row]))
  const orderById = new Map((snapshot.orders as Row[]).map((row) => [Number(row.id), row]))
  const importedRows = IMPORTED_IDS.map((id) => {
    const imported = importByLegacyId.get(id)
    const order = imported ? orderById.get(Number(imported.order_id)) : null
    if (!imported || !order) throw new Error(`Imported order ${id} is missing from post snapshot`)
    const itemCount = (snapshot.orderItems as Row[]).filter((item) => Number(item.order_id) === Number(order.id)).length
    const refund = (snapshot.refunds as Row[]).find((row) => Number(row.order_id) === Number(order.id))
    return {
      "Legacy Order ID": id,
      "Target Order ID": order.id,
      TID: order.tid,
      "Batch ID": imported.batch_id,
      Status: order.status,
      "Fulfillment Status": order.fulfillment_status,
      "Order Items": itemCount,
      Subtotal: Number(order.subtotal_cents) / 100,
      Tax: Number(order.tax_cents) / 100,
      Total: Number(order.total_cents) / 100,
      "Refund Amount": refund ? Number(refund.amount_cents) / 100 : 0,
      "Import Validation": "PASS",
    }
  })

  const summaryRows: Row[] = [
    { Metric: "Organization", Value: "K-Electric only (ID 10, code 0001)", Notes: "Production tenant identity verified." },
    { Metric: "Known legacy orders", Value: 811, Notes: "Established legacy order universe." },
    { Metric: "Currently imported legacy orders", Value: snapshot.legacyOrderImports.length, Notes: "Verified from the post-import production snapshot." },
    { Metric: "Cancelled orders excluded", Value: 88, Notes: "Cancelled orders are absent from every remaining-order detail sheet." },
    { Metric: "Remaining non-cancelled orders", Value: remaining.length, Notes: `IDs: ${remainingIds.join(", ")}.` },
    { Metric: "Newly imported in reviewed batch", Value: IMPORTED_IDS.length, Notes: `IDs: ${IMPORTED_IDS.join(", ")}.` },
    { Metric: "Remaining live item-detail rows", Value: itemRows.length, Notes: "Only item evidence for the 21 remaining orders." },
    { Metric: "Remaining refund-evidence rows", Value: refundRows.length, Notes: "Order 520 was removed because it is now imported." },
    { Metric: "Latest import validation", Value: validation.status, Notes: "Seven imported IDs, financial rows, refunds, tenant isolation and operational-ledger invariants passed." },
    { Metric: "Production database changes made by this report", Value: 0, Notes: "This workbook generation is local and read-only." },
  ]
  const sourceRows: Row[] = [
    { Source: "Prior 28-order live-detail workbook", File: PRIOR_REPORT, Role: "Starting non-cancelled missing-order scope and live evidence." },
    { Source: "Post-import K-Electric snapshot", File: POST_SNAPSHOT, Role: "Authoritative 702-order production ledger after importing seven reviewed orders." },
    { Source: "Seven-order validation", File: VALIDATION, Role: "PASS evidence for the seven newly imported orders." },
    { Source: "Current 21-order workbook", File: OUTPUT, Role: "Updated remaining non-cancelled K-Electric order report." },
  ]

  if (remaining.length !== 21 || importedRows.length !== 7 || reasonRows.reduce((sum, row) => sum + Number(row.Orders), 0) !== 21) throw new Error("Report count validation failed")
  if (remaining.some((row) => IMPORTED_IDS.includes(Number(row["Legacy Order ID"])))) throw new Error("Imported order entered remaining report")

  const workbook = XLSX.utils.book_new()
  addSheet(workbook, "Summary", summaryRows)
  addSheet(workbook, "Remaining Orders", remaining, { money: ["Live Subtotal", "Live Tax", "Live Grand Total", "Live Refund Amount", "Live Tax Refund"], integers: ["Legacy Order ID", "Live StatusID", "Live DeliveryStatus", "Live Item Rows", "Positive Item Rows"] })
  addSheet(workbook, "Reason Summary", reasonRows)
  addSheet(workbook, "Live Detail Items", itemRows, { money: ["Live Detail Line Total", "Historic Unit Price", "Historic Line Total"] })
  addSheet(workbook, "Refund Evidence", refundRows, { money: ["Detail Remaining Line Value", "Modal Unit Price", "Modal Refund Price", "Checkout Refund Amount", "Checkout Tax Refund"] })
  addSheet(workbook, "Newly Imported 7", importedRows, { money: ["Subtotal", "Tax", "Total", "Refund Amount"], integers: ["Legacy Order ID", "Target Order ID", "Order Items"] })
  addSheet(workbook, "Source Files", sourceRows)
  XLSX.writeFile(workbook, OUTPUT, { bookType: "xlsx", compression: true, cellStyles: true })

  const validationWorkbook = XLSX.readFile(OUTPUT)
  const validationRemaining = rows(validationWorkbook, "Remaining Orders")
  if (validationRemaining.length !== 21 || validationWorkbook.SheetNames.length !== 7) throw new Error("Workbook read-back validation failed")
  const buffer = readFileSync(OUTPUT)
  const result = {
    generatedAt: new Date().toISOString(),
    organization: { id: 10, code: "0001", name: "K-Electric" },
    knownLegacyOrders: 811,
    importedLegacyOrders: snapshot.legacyOrderImports.length,
    cancelledExcluded: 88,
    remainingNonCancelledOrders: remaining.length,
    remainingLegacyOrderIds: remainingIds,
    newlyImportedLegacyOrderIds: IMPORTED_IDS,
    itemEvidenceRows: itemRows.length,
    refundEvidenceRows: refundRows.length,
    productionDatabaseChanges: 0,
    workbook: { path: OUTPUT, bytes: buffer.byteLength, sha256: createHash("sha256").update(buffer).digest("hex"), sheets: validationWorkbook.SheetNames },
  }
  writeFileSync(OUTPUT_JSON, `${JSON.stringify(result, null, 2)}\n`, "utf8")
  console.log(JSON.stringify({ output: OUTPUT, outputJson: OUTPUT_JSON, ...result }, null, 2))
}

main()
