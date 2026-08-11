#!/usr/bin/env tsx
import { stringifyPrimitive } from "../lib/stringify-primitive"

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

type Row = Record<string, any>

const REPORT_DATE = "2026-08-03"
const EXPECTED_IDS = [118, 154, 158, 159, 161, 216, 217, 628, 704, 936, 997, 1029, 1032, 1083, 1099, 1102, 1112, 1131, 1156]
const SOURCE_LINES = resolve("updatedReports/orderPurchaseReport.json")
const LIVE_ARTIFACT = resolve(`updatedReports/ke-live-item-price-history-mismatch-orders-${REPORT_DATE}.json`)
const OUTPUT_ROOT = resolve(`updatedReports/ke-live-price-reconciled-19-orders-${REPORT_DATE}`)
const REPORT_ROOT = resolve(OUTPUT_ROOT, "reports")

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

function normalize(value: unknown): string {
  return stringifyPrimitive(value)
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function normalizeProduct(value: unknown): string {
  return normalize(value)
    .replaceAll(" (", "(")
    .replaceAll("( ", "(")
    .replaceAll("(", " (")
    .replaceAll(" )", ")")
    .replaceAll(") ", ")")
    .replaceAll(" -", "-")
    .replaceAll("- ", "-")
}

function dateKey(value: unknown): string {
  const raw = stringifyPrimitive(value)
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw)
  if (!match) throw new Error(`Invalid date: ${raw}`)
  return match[1]
}

function toCents(value: unknown): number {
  const parsed = Number(value ?? 0)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid monetary value: ${stringifyPrimitive(value)}`)
  return Math.round((parsed + Number.EPSILON) * 100)
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex")
}

function writeJson(path: string, value: unknown): { path: string; bytes: number; sha256: string } {
  const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8")
  writeFileSync(path, buffer)
  return { path, bytes: buffer.byteLength, sha256: sha256(buffer) }
}

function main() {
  const expectedSet = new Set(EXPECTED_IDS)
  const allSourceLines = readJson<Row[]>(SOURCE_LINES)
  const liveArtifact = readJson<{ safety: Row; queries: Row[] }>(LIVE_ARTIFACT)
  if (liveArtifact.safety?.mutationsIssued !== 0) throw new Error("Live artifact does not assert zero source mutations")
  const queriesById = new Map(liveArtifact.queries.map((query) => [Number(query.legacyOrderId), query]))
  const sourceById = new Map<number, Row[]>()
  for (const row of allSourceLines) {
    const id = Number(row.ID)
    if (!expectedSet.has(id)) continue
    sourceById.set(id, [...(sourceById.get(id) ?? []), row])
  }

  const orderHeaders: Row[] = []
  const correctedSalesLines: Row[] = []
  const scopedHistoryRows: Row[] = []
  const evidenceRows: Row[] = []

  for (const legacyOrderId of EXPECTED_IDS) {
    const sourceLines = sourceById.get(legacyOrderId)
    const query = queriesById.get(legacyOrderId)
    if (!sourceLines || !query) throw new Error(`Missing source/live evidence for order ${legacyOrderId}`)
    const detail = query.orderDetail as Row
    const detailLines = detail.OrderDetailsList as Row[]
    const checkout = Array.isArray(detail.OrderCheckoutList) ? detail.OrderCheckoutList[0] : null
    const historyRows = query.rows as Row[]
    if (!checkout || detailLines.length !== sourceLines.length) throw new Error(`Order ${legacyOrderId} detail shape/count mismatch`)
    if (Number(detail.StatusID) !== 2 || Number(detail.DeliveryStatus) !== 507) {
      throw new Error(`Order ${legacyOrderId} is not delivered/fulfilled in live detail`)
    }
    if (Number(checkout.RefundAmount ?? 0) !== 0 || detailLines.some((line) => Number(line.RefundQuantity ?? 0) !== 0)) {
      throw new Error(`Order ${legacyOrderId} contains refund evidence`)
    }
    const first = sourceLines[0]
    const headerSubtotalCents = toCents(first.AmountTotal)
    const detailSubtotalCents = detailLines.reduce((sum, line) => sum + toCents(line.Price), 0)
    if (toCents(checkout.AmountTotal) !== headerSubtotalCents || detailSubtotalCents !== headerSubtotalCents) {
      throw new Error(`Order ${legacyOrderId} live detail does not reconcile to the exported header`)
    }
    if (toCents(checkout.GrandTotal) !== toCents(first.GrandTotal) || toCents(checkout.Tax) !== toCents(first.Tax)) {
      throw new Error(`Order ${legacyOrderId} checkout tax/total differs from the export`)
    }

    const historyByName = new Map<string, Set<number>>()
    for (const row of historyRows) {
      if (dateKey(row.Date) !== String(query.orderDate)) continue
      if (normalize(row.Location) !== normalize(query.location)) continue
      const key = normalizeProduct(row.ItemName)
      const prices = historyByName.get(key) ?? new Set<number>()
      prices.add(toCents(row.Price))
      historyByName.set(key, prices)
    }

    sourceLines.forEach((sourceLine, index) => {
      const detailLine = detailLines[index]
      const sourceQuantity = Number(sourceLine.ItemQuantity)
      const detailQuantity = Number(detailLine.Quantity)
      if (sourceQuantity <= 0 || sourceQuantity !== detailQuantity) {
        throw new Error(`Order ${legacyOrderId} line ${index + 1} quantity/order mismatch`)
      }
      const prices = [...(historyByName.get(normalizeProduct(detailLine.Name)) ?? [])]
      if (prices.length !== 1) {
        throw new Error(`Order ${legacyOrderId} line ${index + 1} has ${prices.length} exact live history prices`)
      }
      const historicUnitPriceCents = prices[0]
      const historicLineTotalCents = historicUnitPriceCents * detailQuantity
      if (historicLineTotalCents !== toCents(detailLine.Price)) {
        throw new Error(`Order ${legacyOrderId} line ${index + 1} history price does not equal live detail total`)
      }
      correctedSalesLines.push({
        ...sourceLine,
        UnitPrice: historicUnitPriceCents / 100,
      })
      scopedHistoryRows.push({
        Date: query.orderDate,
        ItemName: sourceLine.ItemDetails,
        Location: sourceLine.Location,
        LocationGroup: sourceLine.LocationGroup,
        Price: historicUnitPriceCents / 100,
      })
      evidenceRows.push({
        legacyOrderId,
        lineNumber: index + 1,
        locationId: Number(query.locationId),
        branch: String(query.location),
        orderDate: String(query.orderDate),
        liveOrderDetailId: Number(detailLine.ID),
        liveItemId: Number(detailLine.ItemId),
        exportedItemName: String(sourceLine.ItemDetails),
        liveDetailItemName: String(detailLine.Name),
        sameNormalizedName: normalizeProduct(sourceLine.ItemDetails) === normalizeProduct(detailLine.Name),
        quantity: detailQuantity,
        exportedUnitPrice: Number(sourceLine.UnitPrice),
        historicUnitPrice: historicUnitPriceCents / 100,
        liveDetailLineTotal: Number(detailLine.Price),
        historicLineTotal: historicLineTotalCents / 100,
        checks: {
          sameLinePosition: true,
          sameQuantity: true,
          uniqueExactBranchDateHistoryPrice: true,
          historyTimesQuantityEqualsDetailLineTotal: true,
        },
      })
    })

    const correctedOrderSubtotalCents = correctedSalesLines
      .filter((line) => Number(line.ID) === legacyOrderId)
      .reduce((sum, line) => sum + toCents(line.UnitPrice) * Number(line.ItemQuantity), 0)
    if (correctedOrderSubtotalCents !== headerSubtotalCents) {
      throw new Error(`Order ${legacyOrderId} corrected lines do not reconcile to header`)
    }

    orderHeaders.push({
      ...first,
      ID: legacyOrderId,
      LocationID: Number(detail.LocationID),
      TransactionNo: first.TransactionNo,
      OrderNo: Number(detail.OrderNo),
      OrderTakerID: Number(detail.OrderTakerID),
      OrderCreatedDT: detail.OrderCreatedDT,
      StatusID: Number(detail.StatusID),
      LastUpdateBy: detail.LastUpdatedBy ?? first.LastUpdateBy,
      LastUpdateDT: detail.LastUpdateDT,
      CreatedOn: first.CreatedOn ?? detail.OrderCreatedDT,
      DeliveryStatus: Number(detail.DeliveryStatus),
      UserDetails: first.UserDetails,
      GrandTotal: Number(checkout.GrandTotal),
      RefundAmount: 0,
      LocationName: first.Location,
      LocationGroup: first.LocationGroup,
    })
  }

  if (orderHeaders.length !== 19 || correctedSalesLines.length !== 218 || evidenceRows.length !== 218) {
    throw new Error("Candidate source count validation failed")
  }
  const uniqueHistory = [...new Map(scopedHistoryRows.map((row) => [
    `${row.Date}|${normalize(row.Location)}|${normalizeProduct(row.ItemName)}|${row.Price}`,
    row,
  ])).values()]

  mkdirSync(REPORT_ROOT, { recursive: true })
  const files = {
    order: writeJson(resolve(REPORT_ROOT, "order.json"), orderHeaders),
    sales: writeJson(resolve(REPORT_ROOT, "sales-report.json"), correctedSalesLines),
    summary: writeJson(resolve(REPORT_ROOT, "user-product-summary-report.json"), []),
    history: writeJson(resolve(REPORT_ROOT, "item-price-history-report.json"), uniqueHistory),
    evidence: writeJson(resolve(OUTPUT_ROOT, "line-mapping-evidence.json"), evidenceRows),
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    scope: "K-Electric only",
    legacyOrderIds: EXPECTED_IDS,
    orders: orderHeaders.length,
    salesLines: correctedSalesLines.length,
    transactionScopedHistoryRows: uniqueHistory.length,
    renamedOrTruncatedExportLabels: evidenceRows.filter((row) => !row.sameNormalizedName).length,
    unitPricesChangedFromFlatExport: evidenceRows.filter((row) => row.exportedUnitPrice !== row.historicUnitPrice).length,
    allHeadersReconciled: true,
    allLiveDetailLinesReconciled: true,
    sourceMutations: 0,
    productionDatabaseChanges: 0,
    provenance: {
      flatExport: SOURCE_LINES,
      liveReadArtifact: LIVE_ARTIFACT,
      method: "Preserve exported item label for established target mappings; align to the live detail row by unchanged line position and quantity; take unit price from the exact LocationID/order-date history row matched through the live detail item name/ItemID.",
    },
    files,
  }
  const summaryFile = writeJson(resolve(OUTPUT_ROOT, "candidate-manifest.json"), summary)
  console.log(JSON.stringify({ outputRoot: OUTPUT_ROOT, reportRoot: REPORT_ROOT, ...summary, summaryFile }, null, 2))
}

main()
