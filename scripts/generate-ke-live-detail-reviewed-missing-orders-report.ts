#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import * as XLSX from "xlsx"

type Row = Record<string, any>

const PRIOR_WORKBOOK = resolve("updatedReports/ke-current-missing-orders-excluding-cancelled-2026-08-03.xlsx")
const LIVE_AUDIT = resolve("updatedReports/ke-current-missing-orders-live-detail-audit-2026-08-04.json")
const TARGET_ASSESSMENT = resolve("updatedReports/ke-current-missing-safe-candidates-2026-08-04/target-snapshot-assessment.json")
const REFUND_PREFLIGHT = resolve("updatedReports/ke-production-refund-import-preflight-2026-08-03-v6.json")
const OUTPUT = resolve("updatedReports/ke-missing-orders-live-detail-reviewed-excluding-cancelled-2026-08-04.xlsx")
const OUTPUT_JSON = resolve("updatedReports/ke-missing-orders-live-detail-reviewed-excluding-cancelled-2026-08-04.json")
const CANDIDATE_IDS = [250, 520, 765, 1164, 1165, 1177, 1187]

function normalize(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()
}

function money(value: unknown): number | null {
  if (value == null || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function statusLabel(statusId: unknown, deliveryStatus: unknown): string {
  const sid = Number(statusId)
  const ds = Number(deliveryStatus)
  if (sid === 4) return "Refunded"
  if (ds === 505) return "Partial"
  if (ds === 507) return sid === 1 ? "Delivery code 507 but order still placed" : "Delivered"
  if (ds === 506) return "Out For Delivery"
  if (ds === 503) return "In Process"
  if (ds === 502) return "Accepted"
  if (ds === 501) return "Order Placed"
  return `Unknown (${sid}/${ds})`
}

function autoWidth(rows: Row[], headers: string[]): XLSX.ColInfo[] {
  return headers.map((header) => ({ wch: Math.min(70, Math.max(11, header.length + 2, ...rows.slice(0, 500).map((row) => String(row[header] ?? "").length + 2))) }))
}

function addSheet(workbook: XLSX.WorkBook, name: string, rows: Row[], options: { money?: string[]; integers?: string[] } = {}) {
  const safeRows = rows.length ? rows : [{ Notice: "No rows" }]
  const headers = Object.keys(safeRows[0])
  const sheet = XLSX.utils.json_to_sheet(safeRows, { header: headers })
  sheet["!cols"] = autoWidth(safeRows, headers)
  sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: safeRows.length, c: headers.length - 1 } }) }
  sheet["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" } as any
  const formats = new Map<string, string>()
  for (const header of options.money ?? []) formats.set(header, "#,##0.00;[Red]-#,##0.00")
  for (const header of options.integers ?? []) formats.set(header, "0")
  for (const [header, format] of formats) {
    const column = headers.indexOf(header)
    if (column < 0) continue
    for (let row = 1; row <= safeRows.length; row += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })]
      if (cell && cell.t === "n") cell.z = format
    }
  }
  XLSX.utils.book_append_sheet(workbook, sheet, name)
}

function main() {
  const prior = XLSX.readFile(PRIOR_WORKBOOK, { cellDates: false })
  const priorRows = XLSX.utils.sheet_to_json<Row>(prior.Sheets["Missing Orders"], { defval: null, raw: true })
  const live = JSON.parse(readFileSync(LIVE_AUDIT, "utf8")) as Row
  const target = JSON.parse(readFileSync(TARGET_ASSESSMENT, "utf8")) as Row
  const refundPreflight = JSON.parse(readFileSync(REFUND_PREFLIGHT, "utf8")) as Row
  const liveById = new Map((live.orders as Row[]).map((row) => [Number(row.legacyOrderId), row]))
  const targetById = new Map((target.assessments as Row[]).map((row) => [Number(row.legacyOrderId), row]))
  const priorById = new Map(priorRows.map((row) => [Number(row["Legacy Order ID"]), row]))
  const refundSourceExclusionById = new Map((refundPreflight.sourceExcluded as Row[] ?? []).map((row) => [Number(row.legacyOrderId), row]))
  const candidateSet = new Set(CANDIDATE_IDS)

  function blockedReason(id: number, order: Row): string {
    if (!order.realDetail) return "Live detail returned the default empty ID 0 object with no items or checkout; retain as an abandoned/deleted draft."
    if (id === 44) return "The detail API exposed a partial refund not present in the original missing-header classification: PKR 196.00 item refund plus PKR 35.28 tax refund. Status remains 9/506 Out For Delivery; neither condition is eligible."
    if (id === 43) return "Items and subtotal refund reconcile, but the PKR 116.10 tax refund is unsupported by the current target refund schema/import path."
    if ([173, 174, 177].includes(id)) return "Corrupted refund state: detail prices and modal refund quantities are negative, and item refund totals do not reconcile to the checkout refund amount."
    if (id === 192) return "Refund evidence reconciles, but the latest K-Electric production snapshot has no safe target product mapping for TEST 3."
    if (id === 1100) return "Partial refund evidence reconciles, but the latest K-Electric production snapshot has no safe target product mapping for Millac Tea Whitener 850gm."
    if (id === 415) return "The detail API has two items but no checkout/header totals; StatusID is still 1. DeliveryStatus 507 alone is insufficient evidence of a finalized sale."
    if (id === 60) return "Live state is 9/506 Out For Delivery, not Partial or Delivered. One positive-quantity duplicate item also has a zero line total and two conflicting same-day history prices."
    if (Number(order.detailHeader?.DeliveryStatus) === 506 || Number(order.detailHeader?.StatusID) === 9) return "Live detail remains 9/506 Out For Delivery. The user policy accepts only explicit Partial, not Out For Delivery."
    if (Number(order.detailHeader?.DeliveryStatus) === 503) return "Live detail remains 2/503 In Process. The user policy accepts only explicit Partial, not In Process."
    const sourceExclusion = refundSourceExclusionById.get(id)
    if (sourceExclusion) return `Refund source is excluded: ${sourceExclusion.reasons.join(", ")}.`
    return "Evidence is incomplete or the live order is not in a user-approved final state."
  }

  function candidateReason(id: number, order: Row): string {
    if (id === 520) return "Fully refunded order. The refund modal proves both item prices and refund quantities; item refunds total PKR 4,205.00. The later K-Electric snapshot now contains the required historical user mapping. Use only the refund-aware historical path."
    if (id === 765) return "Live detail is 2/505 Partial. Accepted as delivered only under the user's explicit rule; all seven items, exact date/location prices, subtotal, tax, and grand total reconcile."
    if ([250, 1165, 1177].includes(id)) return `Live detail is delivered and reconciled. Exclude ${order.zeroQuantityItemRows} zero-quantity, zero-value artifact line; all positive lines and totals reconcile.`
    if ([1164, 1187].includes(id)) return "The individual live detail now returns 2/507 Delivered (newer than the export), with reconciled items, historical prices, subtotal, tax, and grand total."
    return "Live individual detail and price history reconcile."
  }

  const assessments = priorRows.map((priorRow) => {
    const id = Number(priorRow["Legacy Order ID"])
    const order = liveById.get(id)
    if (!order) throw new Error(`Missing live audit row ${id}`)
    const candidate = candidateSet.has(id)
    const targetRow = targetById.get(id)
    const liveStatus = order.realDetail ? statusLabel(order.detailHeader?.StatusID, order.detailHeader?.DeliveryStatus) : "No live record"
    return {
      "Legacy Order ID": id,
      "Branch / Location": order.branch,
      "Original Blocker Code": priorRow["Blocker Code"],
      "Prior Export Status": priorRow["Updated Order Status"] || priorRow["Current Interpretation"],
      "Live Status": liveStatus,
      "Live StatusID": order.detailHeader?.StatusID ?? null,
      "Live DeliveryStatus": order.detailHeader?.DeliveryStatus ?? null,
      "Live Order No": order.detailHeader?.OrderNo ?? priorRow["Order No"],
      "Live Transaction No": order.detailHeader?.TransactionNo ?? priorRow["Transaction No"],
      "Live Order Date": order.detailHeader?.OrderCreatedDT ?? null,
      "Live Detail Record": order.realDetail ? "YES" : "NO",
      "Checkout Rows": order.checkoutRows,
      "Live Item Rows": order.itemRows,
      "Positive Item Rows": order.positiveItemRows,
      "Zero-Qty Zero-Value Artifacts": order.zeroQuantityZeroValueArtifactRows,
      "Live Subtotal": order.checkoutSubtotalCents == null ? null : Number(order.checkoutSubtotalCents) / 100,
      "Live Tax": money(order.checkout?.Tax),
      "Live Grand Total": money(order.checkout?.GrandTotal),
      "Live Refund Amount": money(order.checkout?.RefundAmount),
      "Live Tax Refund": money(order.checkout?.TaxRefund),
      "Detail Subtotal Reconciles": order.subtotalReconciles ? "YES" : "NO",
      "Exact Price History Reconciles": order.historyComplete ? "YES" : "NO",
      "Refund Evidence": order.refundEvidence ? "YES" : "NO",
      "Partial-as-Delivered Policy Applied": order.userPolicyAcceptedAsDelivered ? "YES" : "NO",
      "Assessment": candidate ? "PROVISIONAL IMPORT CANDIDATE" : "BLOCKED / EXCLUDE",
      "Required Import Path": candidate ? (id === 520 ? "Refund-aware historical import" : "Normal reviewed historical import") : "None until blocker is resolved",
      "Evidence Explanation": candidate ? candidateReason(id, order) : blockedReason(id, order),
      "Latest K-Electric Snapshot Mapping": targetRow ? (targetRow.snapshotReady ? "PASS" : "BLOCKED") : "NOT APPLICABLE",
      "New Historical User Needed": targetRow?.user?.kind === "HISTORICAL_USER_REQUIRED" ? "YES" : "NO",
      "New Products Needed": targetRow?.newProductsRequired ?? 0,
      "New Inactive Branch Assignments Needed": targetRow?.newBranchAssignmentsRequired ?? 0,
      "Safe to Import Immediately": "NO",
      "Immediate Import Gate": candidate
        ? "Fresh production dry-run required. Current configured databases do not contain K-Electric organization ID 10, so the tenant guard stopped preflight."
        : "Source/business evidence blocker remains.",
    }
  }).sort((a, b) => Number(a["Legacy Order ID"]) - Number(b["Legacy Order ID"]))

  const candidates = assessments.filter((row) => row.Assessment === "PROVISIONAL IMPORT CANDIDATE")
  const blocked = assessments.filter((row) => row.Assessment === "BLOCKED / EXCLUDE")
  const itemRows = (live.orders as Row[]).flatMap((order) => (order.itemEvidence as Row[]).map((item) => ({
    "Legacy Order ID": order.legacyOrderId,
    Branch: order.branch,
    "Live Status": order.realDetail ? statusLabel(order.detailHeader?.StatusID, order.detailHeader?.DeliveryStatus) : "No live record",
    "Line No": item.lineNumber,
    "Legacy Item Row ID": item.ID,
    "Legacy Item ID": item.ItemId,
    "Item Name": item.Name,
    Quantity: item.Quantity,
    "Refund Quantity": item.RefundQuantity,
    "Live Detail Line Total": item.Price,
    "Historic Unit Price": item.selectedHistoryUnitPriceCents == null ? null : Number(item.selectedHistoryUnitPriceCents) / 100,
    "Historic Line Total": item.selectedHistoryLineTotalCents == null ? null : Number(item.selectedHistoryLineTotalCents) / 100,
    "History Price Count": item.exactHistoryPriceCount,
    "History Matches Detail": item.historyMatchesDetail ? "YES" : "NO",
    "Import Treatment": Number(item.Quantity) === 0 && item.zeroQuantityZeroValueArtifact
      ? "EXCLUDE ZERO-QUANTITY ZERO-VALUE ARTIFACT"
      : (candidateSet.has(Number(order.legacyOrderId)) ? "INCLUDE IF FRESH PREFLIGHT PASSES" : "DO NOT IMPORT WHILE ORDER BLOCKED"),
  })))

  const refundRows = (live.orders as Row[]).filter((order) => order.refundEvidence).flatMap((order) => {
    const modalById = new Map((order.refundModal?.itemRows as Row[] ?? []).map((item) => [Number(item.ID), item]))
    return (order.itemEvidence as Row[]).map((item) => {
      const modal = modalById.get(Number(item.ID))
      return {
        "Legacy Order ID": order.legacyOrderId,
        Branch: order.branch,
        "Live Status": statusLabel(order.detailHeader?.StatusID, order.detailHeader?.DeliveryStatus),
        "Item Name": item.Name,
        Quantity: item.Quantity,
        "Detail Refund Quantity": item.RefundQuantity,
        "Detail Remaining Line Value": item.Price,
        "Modal Remaining Quantity": modal?.RefundQuantity ?? null,
        "Modal Unit Price": modal?.UnitPrice ?? null,
        "Modal Refund Price": modal?.RefundPrice ?? null,
        "Checkout Refund Amount": order.checkout?.RefundAmount ?? null,
        "Checkout Tax Refund": order.checkout?.TaxRefund ?? null,
        "Negative Detail State": Number(item.Price ?? 0) < 0 ? "YES" : "NO",
        "Negative Modal Quantity": Number(modal?.RefundQuantity ?? 0) < 0 ? "YES" : "NO",
        "Assessment": candidateSet.has(Number(order.legacyOrderId)) ? "PROVISIONAL REFUND-AWARE CANDIDATE" : "BLOCKED",
      }
    })
  })

  const targetRows = (target.assessments as Row[]).map((row) => ({
    "Legacy Order ID": row.legacyOrderId,
    "Import Path": row.importPath,
    "Snapshot Date": target.snapshot.generatedAt,
    "Snapshot Mapping Pass": row.snapshotReady ? "YES" : "NO",
    "Branch ID": row.branch?.id ?? null,
    Branch: row.branch?.name ?? null,
    "User Resolution": row.user?.kind ?? null,
    "User ID": row.user?.user?.id ?? row.user?.mapping?.user_id ?? null,
    "New Products Required": row.newProductsRequired ?? 0,
    "New Inactive Branch Assignments Required": row.newBranchAssignmentsRequired ?? 0,
    "Snapshot Blockers": (row.reasons ?? []).join(", "),
    "Current Production Preflight": "NOT COMPLETED - CONNECTED DATABASE FAILED K-ELECTRIC TENANT GATE",
  }))

  const summaryRows: Row[] = [
    { Metric: "Organization scope", Value: "K-Electric only (ID 10, code 0001)", Notes: "No other organization is included in the order assessment." },
    { Metric: "Non-cancelled missing orders reviewed", Value: assessments.length, Notes: "All 28 orders from the prior updated report were checked through the individual detail API." },
    { Metric: "Cancelled orders included", Value: 0, Notes: "Cancelled orders remain excluded." },
    { Metric: "Individual live detail records found", Value: live.summary.realDetails, Notes: "Seven omitted draft IDs still return empty ID 0 records." },
    { Metric: "Provisional import candidates", Value: candidates.length, Notes: `IDs: ${candidates.map((row) => row["Legacy Order ID"]).join(", ")}.` },
    { Metric: "Normal historical candidates", Value: 6, Notes: "IDs 250, 765, 1164, 1165, 1177, 1187." },
    { Metric: "Refund-aware historical candidates", Value: 1, Notes: "ID 520 only; do not use the normal operational order API." },
    { Metric: "Partial accepted as delivered", Value: 1, Notes: "ID 765 only. In Process and Out For Delivery were not promoted." },
    { Metric: "Still blocked/excluded", Value: blocked.length, Notes: "These orders retain source/status/refund/product blockers or have no live record." },
    { Metric: "Latest K-Electric snapshot candidate mapping", Value: `${target.summary.snapshotReady}/${target.summary.candidates} pass`, Notes: `Snapshot time ${target.snapshot.generatedAt}; this is not a current production preflight.` },
    { Metric: "Fresh production dry-run", Value: "BLOCKED BY TENANT GATE", Notes: "The currently configured database connections do not contain K-Electric organization ID 10. The importer correctly stopped before candidate mapping queries." },
    { Metric: "Safe to import immediately", Value: "NO", Notes: "Reconnect to the correct K-Electric production database and rerun both normal and refund-aware dry-runs before any write." },
    { Metric: "Legacy source mutations", Value: 0, Notes: "Only read endpoints were called; price history POST is a read-only report query." },
    { Metric: "Production database changes", Value: 0, Notes: "No order or other production row was inserted, updated, or deleted." },
  ]

  const guideRows: Row[] = [
    { Decision: "PROVISIONAL IMPORT CANDIDATE", Meaning: "Individual detail, items, price history, totals, status/refund evidence, and the latest K-Electric snapshot mapping are sufficient to prepare a candidate.", NextStep: "Run a fresh tenant-verified production dry-run; import only if it reports zero blockers." },
    { Decision: "BLOCKED / EXCLUDE", Meaning: "A current business/source blocker remains, or no real live record exists.", NextStep: "Do not import until the stated evidence or mapping issue is resolved." },
    { Decision: "Partial policy", Meaning: "Only explicit Partial / DeliveryStatus 505 is accepted as delivered under the user's instruction.", NextStep: "Applied only to legacy order 765." },
    { Decision: "Out For Delivery / In Process", Meaning: "Not accepted as delivered.", NextStep: "Wait for a final live status or obtain a separate explicit policy." },
    { Decision: "Zero-quantity artifact", Meaning: "A line with quantity 0 and line total 0 may be omitted while positive lines and header totals remain unchanged.", NextStep: "Applied to 250, 1165, and 1177 in the prepared candidate source." },
  ]

  const sourceRows: Row[] = [
    { Source: "Prior 28-order workbook", File: PRIOR_WORKBOOK, Role: "Defines the complete non-cancelled missing-order scope." },
    { Source: "Live individual-detail audit", File: LIVE_AUDIT, Role: "Raw detail, checkout, item, exact date/location price history, and refund-modal responses for all 28 orders." },
    { Source: "Prepared normal candidates", File: resolve("updatedReports/ke-current-missing-safe-candidates-2026-08-04/candidate-manifest.json"), Role: "Six normal historical candidates; no database writes." },
    { Source: "Latest K-Electric target snapshot assessment", File: TARGET_ASSESSMENT, Role: "Offline mapping/duplicate assessment after the latest completed K-Electric batches; not a current production preflight." },
    { Source: "Prior refund-aware preflight", File: REFUND_PREFLIGHT, Role: "Explains refund source exclusions and the former target mapping blocker for order 520." },
    { Source: "Current workbook", File: OUTPUT, Role: "Live-detail-reviewed missing-order report, excluding cancelled orders." },
  ]

  if (assessments.length !== 28 || new Set(assessments.map((row) => row["Legacy Order ID"])).size !== 28) throw new Error("Assessment scope validation failed")
  if (candidates.length !== 7 || blocked.length !== 21) throw new Error(`Decision counts failed: ${candidates.length}/${blocked.length}`)
  if (assessments.some((row) => normalize(priorById.get(Number(row["Legacy Order ID"]))?.["Current Interpretation"]) === "cancelled")) throw new Error("Cancelled order entered workbook")
  if ((target.assessments as Row[]).some((row) => !row.snapshotReady)) throw new Error("Candidate failed target snapshot assessment")

  const workbook = XLSX.utils.book_new()
  addSheet(workbook, "Summary", summaryRows)
  addSheet(workbook, "Order Assessment", assessments, { money: ["Live Subtotal", "Live Tax", "Live Grand Total", "Live Refund Amount", "Live Tax Refund"], integers: ["Legacy Order ID", "Live StatusID", "Live DeliveryStatus", "Live Item Rows", "Positive Item Rows"] })
  addSheet(workbook, "Provisional Candidates", candidates, { money: ["Live Subtotal", "Live Tax", "Live Grand Total", "Live Refund Amount", "Live Tax Refund"] })
  addSheet(workbook, "Still Blocked", blocked, { money: ["Live Subtotal", "Live Tax", "Live Grand Total", "Live Refund Amount", "Live Tax Refund"] })
  addSheet(workbook, "Live Detail Items", itemRows, { money: ["Live Detail Line Total", "Historic Unit Price", "Historic Line Total"] })
  addSheet(workbook, "Refund Evidence", refundRows, { money: ["Detail Remaining Line Value", "Modal Unit Price", "Modal Refund Price", "Checkout Refund Amount", "Checkout Tax Refund"] })
  addSheet(workbook, "Target Snapshot", targetRows)
  addSheet(workbook, "Decision Guide", guideRows)
  addSheet(workbook, "Source Files", sourceRows)
  XLSX.writeFile(workbook, OUTPUT, { bookType: "xlsx", compression: true, cellStyles: true })

  const validation = XLSX.readFile(OUTPUT)
  const validationRows = XLSX.utils.sheet_to_json<Row>(validation.Sheets["Order Assessment"], { defval: null })
  if (validationRows.length !== 28 || validation.SheetNames.length !== 9) throw new Error("Workbook validation failed")
  const buffer = readFileSync(OUTPUT)
  const report = {
    generatedAt: new Date().toISOString(),
    organization: { id: 10, code: "0001", name: "K-Electric" },
    nonCancelledMissingOrdersReviewed: 28,
    cancelledOrdersIncluded: 0,
    provisionalCandidateIds: CANDIDATE_IDS,
    blockedIds: blocked.map((row) => Number(row["Legacy Order ID"])),
    partialAcceptedAsDeliveredIds: [765],
    normalHistoricalCandidateIds: [250, 765, 1164, 1165, 1177, 1187],
    refundAwareCandidateIds: [520],
    productionPreflight: { completed: false, reason: "Configured database connections do not contain K-Electric organization ID 10; tenant safety gate stopped the dry-run." },
    sourceMutations: 0,
    productionDatabaseChanges: 0,
    workbook: { path: OUTPUT, bytes: buffer.byteLength, sha256: createHash("sha256").update(buffer).digest("hex"), sheets: validation.SheetNames },
  }
  writeFileSync(OUTPUT_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log(JSON.stringify({ output: OUTPUT, outputJson: OUTPUT_JSON, ...report }, null, 2))
}

main()
