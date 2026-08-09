#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import * as XLSX from "xlsx"

type Row = Record<string, any>

const AUDIT = resolve("updatedReports/ke-current-missing-orders-live-detail-audit-2026-08-04.json")
const WORKBOOK = resolve("updatedReports/ke-current-missing-orders-excluding-cancelled-2026-08-03.xlsx")
const OUTPUT_ROOT = resolve("updatedReports/ke-current-missing-safe-candidates-2026-08-04")
const REPORT_ROOT = resolve(OUTPUT_ROOT, "reports")
const EXPECTED_IDS = [250, 765, 1164, 1165, 1177, 1187]

function cents(value: unknown): number {
  return Math.round((Number(value ?? 0) + Number.EPSILON) * 100)
}

function normalize(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()
}

function writeJson(path: string, value: unknown) {
  const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8")
  writeFileSync(path, buffer)
  return { path, bytes: buffer.byteLength, sha256: createHash("sha256").update(buffer).digest("hex") }
}

function main() {
  const audit = JSON.parse(readFileSync(AUDIT, "utf8")) as Row
  if (audit.safety?.sourceMutationsIssued !== 0 || audit.safety?.productionDatabaseChanges !== 0) throw new Error("Audit safety declaration failed")
  const workbook = XLSX.readFile(WORKBOOK, { cellDates: false })
  const reportRows = XLSX.utils.sheet_to_json<Row>(workbook.Sheets["Missing Orders"], { defval: null, raw: true })
  const reportById = new Map(reportRows.map((row) => [Number(row["Legacy Order ID"]), row]))
  const candidates = (audit.orders as Row[]).filter((order) => order.normalOrderEvidenceComplete)
  const candidateIds = candidates.map((order) => Number(order.legacyOrderId)).sort((a, b) => a - b)
  if (JSON.stringify(candidateIds) !== JSON.stringify(EXPECTED_IDS)) throw new Error(`Unexpected safe candidates: ${candidateIds.join(", ")}`)

  const headers: Row[] = []
  const sales: Row[] = []
  const history: Row[] = []
  const evidence: Row[] = []

  for (const order of candidates) {
    const id = Number(order.legacyOrderId)
    const report = reportById.get(id)
    if (!report) throw new Error(`Missing report row ${id}`)
    const detail = order.rawDetail as Row
    const checkout = order.checkout as Row
    if (!detail || !checkout || !order.realDetail || order.refundEvidence || !order.subtotalReconciles || !order.historyComplete) throw new Error(`Evidence gate failed for ${id}`)
    if (!(order.finalDelivered || order.explicitlyPartial)) throw new Error(`Status policy gate failed for ${id}`)
    if (order.explicitlyPartial && Number(detail.DeliveryStatus) !== 505) throw new Error(`Order ${id} partial policy is not backed by DeliveryStatus 505`)
    const positiveLines = (order.itemEvidence as Row[]).filter((item) => Number(item.Quantity) > 0)
    const zeroLines = (order.itemEvidence as Row[]).filter((item) => Number(item.Quantity) === 0)
    if (!positiveLines.length || zeroLines.some((item) => !item.zeroQuantityZeroValueArtifact)) throw new Error(`Item-line gate failed for ${id}`)
    if (cents(checkout.AmountTotal) - cents(checkout.AmountDiscount) + cents(checkout.ServiceCharges) + cents(checkout.Tax) !== cents(checkout.GrandTotal)) {
      throw new Error(`Checkout arithmetic failed for ${id}`)
    }

    for (const item of positiveLines) {
      if (item.exactHistoryPriceCount !== 1 || !item.historyMatchesDetail) throw new Error(`Price evidence failed for ${id} line ${item.lineNumber}`)
      const unitPrice = Number(item.selectedHistoryUnitPriceCents) / 100
      const sourceLine = {
        ID: id,
        StatusID: 2,
        DeliveryStatus: 507,
        LocationID: Number(order.locationId),
        Location: String(order.branch),
        LocationGroup: String(report["Location Group"] ?? ""),
        RegistrationNo: String(report["Registration No(s)"] ?? ""),
        UserDetails: String(report["User Details"] ?? detail.LastUpdatedBy ?? ""),
        ItemDetails: String(item.Name),
        ItemQuantity: Number(item.Quantity),
        UnitPrice: unitPrice,
        AmountTotal: Number(checkout.AmountTotal),
        AmountDiscount: Number(checkout.AmountDiscount ?? 0),
        ServiceCharges: Number(checkout.ServiceCharges ?? 0),
        Tax: Number(checkout.Tax ?? 0),
        GrandTotal: Number(checkout.GrandTotal),
        OrderCreatedDT: String(detail.OrderCreatedDT),
        LastUpdateDT: String(detail.LastUpdateDT ?? detail.OrderCreatedDT),
        ItemId: Number(item.ItemId),
        ItemCode: item.ItemCode ?? null,
      }
      sales.push(sourceLine)
      history.push({
        Date: String(order.liveDate),
        ItemName: String(item.Name),
        Location: String(order.branch),
        LocationGroup: String(report["Location Group"] ?? ""),
        Price: unitPrice,
      })
    }

    headers.push({
      ID: id,
      LocationID: Number(order.locationId),
      OrderNo: Number(detail.OrderNo),
      TransactionNo: detail.TransactionNo,
      OrderTakerID: Number(detail.OrderTakerID),
      StatusID: 2,
      DeliveryStatus: 507,
      GrandTotal: Number(checkout.GrandTotal),
      RefundAmount: 0,
      LocationName: String(order.branch),
      LocationGroup: String(report["Location Group"] ?? ""),
      UserDetails: String(report["User Details"] ?? detail.LastUpdatedBy ?? ""),
      CreatedOn: String(detail.OrderCreatedDT),
      LastUpdateDT: String(detail.LastUpdateDT ?? detail.OrderCreatedDT),
      OriginalStatusID: Number(detail.StatusID),
      OriginalDeliveryStatus: Number(detail.DeliveryStatus),
      MigrationStatusPolicy: order.explicitlyPartial ? "USER_APPROVED_PARTIAL_AS_DELIVERED" : "LIVE_DETAIL_FINAL_DELIVERED",
    })

    for (const item of order.itemEvidence as Row[]) {
      evidence.push({
        legacyOrderId: id,
        originalStatusId: Number(detail.StatusID),
        originalDeliveryStatus: Number(detail.DeliveryStatus),
        statusTreatment: order.explicitlyPartial ? "PARTIAL_ACCEPTED_AS_DELIVERED_BY_USER" : "LIVE_FINAL_DELIVERED",
        lineNumber: item.lineNumber,
        liveItemId: item.ItemId,
        itemName: item.Name,
        quantity: item.Quantity,
        liveDetailLineTotal: Number(item.Price),
        historicUnitPrice: item.selectedHistoryUnitPriceCents == null ? null : Number(item.selectedHistoryUnitPriceCents) / 100,
        importTreatment: Number(item.Quantity) === 0 ? "EXCLUDED_ZERO_QUANTITY_ZERO_VALUE_ARTIFACT" : "INCLUDED",
      })
    }

    const importedSubtotal = sales.filter((row) => Number(row.ID) === id).reduce((sum, row) => sum + cents(row.UnitPrice) * Number(row.ItemQuantity), 0)
    if (importedSubtotal !== cents(checkout.AmountTotal)) throw new Error(`Prepared subtotal failed for ${id}`)
  }

  const uniqueHistory = [...new Map(history.map((row) => [`${row.Date}|${normalize(row.Location)}|${normalize(row.ItemName)}|${row.Price}`, row])).values()]
  mkdirSync(REPORT_ROOT, { recursive: true })
  const files = {
    order: writeJson(resolve(REPORT_ROOT, "order.json"), headers),
    sales: writeJson(resolve(REPORT_ROOT, "sales-report.json"), sales),
    summary: writeJson(resolve(REPORT_ROOT, "user-product-summary-report.json"), []),
    history: writeJson(resolve(REPORT_ROOT, "item-price-history-report.json"), uniqueHistory),
    evidence: writeJson(resolve(OUTPUT_ROOT, "candidate-evidence.json"), evidence),
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    organization: { id: 10, code: "0001", name: "K-Electric" },
    candidateLegacyOrderIds: candidateIds,
    orders: headers.length,
    positiveSalesLines: sales.length,
    excludedZeroQuantityZeroValueArtifacts: evidence.filter((row) => row.importTreatment.startsWith("EXCLUDED")).length,
    partialAcceptedAsDelivered: headers.filter((row) => row.MigrationStatusPolicy === "USER_APPROVED_PARTIAL_AS_DELIVERED").map((row) => row.ID),
    refreshedToLiveFinalDelivered: [1164, 1187],
    sourceMutations: 0,
    productionDatabaseChanges: 0,
    provenance: { audit: AUDIT, workbook: WORKBOOK },
    files,
  }
  const manifestFile = writeJson(resolve(OUTPUT_ROOT, "candidate-manifest.json"), manifest)
  console.log(JSON.stringify({ outputRoot: OUTPUT_ROOT, reportRoot: REPORT_ROOT, ...manifest, manifestFile }, null, 2))
}

main()
