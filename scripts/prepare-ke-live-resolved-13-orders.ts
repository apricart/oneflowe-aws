#!/usr/bin/env tsx
import { stringifyPrimitive } from "../lib/stringify-primitive"

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

type Row = Record<string, any>

const IDS = [145, 400, 406, 485, 672, 677, 712, 727, 771, 777, 989, 1018, 1117]
const SOURCE = resolve("updatedReports/orderPurchaseReport.json")
const LIVE_AUDIT = resolve("updatedReports/ke-unresolved-item-prices-13-live-audit-2026-08-03.json")
const OUTPUT_ROOT = resolve("updatedReports/ke-live-resolved-13-orders-2026-08-03")
const REPORT_ROOT = resolve(OUTPUT_ROOT, "reports")

function normalize(value: unknown): string {
  return stringifyPrimitive(value).normalize("NFKC").replace(/[\u2018\u2019]/g, "'").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim().toLowerCase()
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
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(stringifyPrimitive(value))
  if (!match) throw new Error(`Invalid date: ${stringifyPrimitive(value)}`)
  return match[1]
}

function cents(value: unknown): number {
  return Math.round((Number(value ?? 0) + Number.EPSILON) * 100)
}

function writeJson(path: string, value: unknown) {
  const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8")
  writeFileSync(path, buffer)
  return { path, bytes: buffer.byteLength, sha256: createHash("sha256").update(buffer).digest("hex") }
}

function main() {
  const allSource = JSON.parse(readFileSync(SOURCE, "utf8")) as Row[]
  const audit = JSON.parse(readFileSync(LIVE_AUDIT, "utf8")) as Row
  if (audit.safety?.mutationsIssued !== 0 || audit.summary?.nowResolvedByLiveDetailAndHistory !== 13) {
    throw new Error("Live audit has not resolved all 13 orders under read-only safety")
  }
  const sourceById = new Map<number, Row[]>()
  for (const row of allSource) {
    const id = Number(row.ID)
    if (!IDS.includes(id)) continue
    sourceById.set(id, [...(sourceById.get(id) ?? []), row])
  }
  const responseById = new Map((audit.rawResponses as Row[]).map((row) => [Number(row.legacyOrderId), row]))
  const headers: Row[] = []
  const sales: Row[] = []
  const history: Row[] = []
  const evidence: Row[] = []

  for (const legacyOrderId of IDS) {
    const sourceLines = sourceById.get(legacyOrderId)
    const live = responseById.get(legacyOrderId)
    if (!sourceLines?.length || !live) throw new Error(`Missing evidence for ${legacyOrderId}`)
    const detail = live.detail as Row
    const detailLines = detail.OrderDetailsList as Row[]
    const checkout = detail.OrderCheckoutList?.[0]
    const liveHistory = live.history as Row[]
    if (!checkout || detailLines.length !== sourceLines.length) throw new Error(`Detail count mismatch for ${legacyOrderId}`)
    if (Number(detail.StatusID) !== 2 || Number(detail.DeliveryStatus) !== 507) throw new Error(`Order ${legacyOrderId} is not delivered`)
    if (Number(checkout.RefundAmount ?? 0) !== 0 || detailLines.some((line) => Number(line.RefundQuantity ?? 0) !== 0)) throw new Error(`Order ${legacyOrderId} has refund evidence`)
    const first = sourceLines[0]
    const orderDate = dateKey(first.OrderCreatedDT)
    const priceByName = new Map<string, Set<number>>()
    for (const row of liveHistory) {
      if (dateKey(row.Date) !== orderDate || normalize(row.Location) !== normalize(first.Location)) continue
      const key = normalizeProduct(row.ItemName)
      const values = priceByName.get(key) ?? new Set<number>()
      values.add(cents(row.Price))
      priceByName.set(key, values)
    }
    sourceLines.forEach((sourceLine, index) => {
      const detailLine = detailLines[index]
      const quantity = Number(detailLine.Quantity)
      if (quantity < 0 || quantity !== Number(sourceLine.ItemQuantity)) throw new Error(`Order ${legacyOrderId} line ${index + 1} quantity mismatch`)
      const prices = [...(priceByName.get(normalizeProduct(detailLine.Name)) ?? [])]
      if (prices.length !== 1) throw new Error(`Order ${legacyOrderId} line ${index + 1} has ${prices.length} prices`)
      const priceCents = prices[0]
      if (priceCents * quantity !== cents(detailLine.Price)) throw new Error(`Order ${legacyOrderId} line ${index + 1} total mismatch`)
      evidence.push({
        legacyOrderId,
        lineNumber: index + 1,
        liveItemId: Number(detailLine.ItemId),
        exportedName: String(sourceLine.ItemDetails),
        liveDetailName: String(detailLine.Name),
        quantity,
        exportedUnitPrice: Number(sourceLine.UnitPrice),
        historicUnitPrice: priceCents / 100,
        liveDetailLineTotal: Number(detailLine.Price),
        importTreatment: quantity === 0 ? "EXCLUDED_ZERO_QUANTITY_ARTIFACT" : "INCLUDED",
      })
      if (quantity === 0) return
      sales.push({ ...sourceLine, UnitPrice: priceCents / 100 })
      history.push({ Date: orderDate, ItemName: sourceLine.ItemDetails, Location: sourceLine.Location, LocationGroup: sourceLine.LocationGroup, Price: priceCents / 100 })
    })
    const correctedSubtotal = sales.filter((row) => Number(row.ID) === legacyOrderId).reduce((sum, row) => sum + cents(row.UnitPrice) * Number(row.ItemQuantity), 0)
    if (correctedSubtotal !== cents(first.AmountTotal) || correctedSubtotal !== cents(checkout.AmountTotal)) throw new Error(`Order ${legacyOrderId} subtotal mismatch`)
    if (cents(first.Tax) !== cents(checkout.Tax) || cents(first.GrandTotal) !== cents(checkout.GrandTotal)) throw new Error(`Order ${legacyOrderId} checkout mismatch`)
    headers.push({
      ...first,
      ID: legacyOrderId,
      LocationID: Number(detail.LocationID),
      OrderNo: Number(detail.OrderNo),
      OrderTakerID: Number(detail.OrderTakerID),
      OrderCreatedDT: detail.OrderCreatedDT,
      StatusID: Number(detail.StatusID),
      LastUpdateBy: detail.LastUpdatedBy ?? first.LastUpdateBy,
      LastUpdateDT: detail.LastUpdateDT,
      CreatedOn: first.CreatedOn ?? detail.OrderCreatedDT,
      DeliveryStatus: Number(detail.DeliveryStatus),
      GrandTotal: Number(checkout.GrandTotal),
      RefundAmount: 0,
      LocationName: first.Location,
      LocationGroup: first.LocationGroup,
    })
  }
  if (headers.length !== 13 || sales.length !== 122 || evidence.length !== 137) throw new Error("Prepared candidate count mismatch")
  const uniqueHistory = [...new Map(history.map((row) => [`${row.Date}|${normalize(row.Location)}|${normalizeProduct(row.ItemName)}|${row.Price}`, row])).values()]
  mkdirSync(REPORT_ROOT, { recursive: true })
  const files = {
    order: writeJson(resolve(REPORT_ROOT, "order.json"), headers),
    sales: writeJson(resolve(REPORT_ROOT, "sales-report.json"), sales),
    summary: writeJson(resolve(REPORT_ROOT, "user-product-summary-report.json"), []),
    history: writeJson(resolve(REPORT_ROOT, "item-price-history-report.json"), uniqueHistory),
    evidence: writeJson(resolve(OUTPUT_ROOT, "line-mapping-evidence.json"), evidence),
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    scope: "K-Electric only",
    legacyOrderIds: IDS,
    orders: headers.length,
    salesLines: sales.length,
    excludedZeroQuantityArtifacts: evidence.filter((row) => row.importTreatment === "EXCLUDED_ZERO_QUANTITY_ARTIFACT").length,
    transactionScopedHistoryRows: uniqueHistory.length,
    pricesChangedFromFlatExport: evidence.filter((row) => row.exportedUnitPrice !== row.historicUnitPrice).length,
    sourceMutations: 0,
    productionDatabaseChanges: 0,
    provenance: { source: SOURCE, liveAudit: LIVE_AUDIT },
    files,
  }
  const manifestFile = writeJson(resolve(OUTPUT_ROOT, "candidate-manifest.json"), manifest)
  console.log(JSON.stringify({ outputRoot: OUTPUT_ROOT, reportRoot: REPORT_ROOT, ...manifest, manifestFile }, null, 2))
}

main()
