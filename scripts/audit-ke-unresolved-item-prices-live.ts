#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

type Row = Record<string, any>

const IDS = [145, 400, 406, 485, 672, 677, 712, 727, 771, 777, 989, 1018, 1117]
const HISTORY_ENDPOINT = "https://logistics.oneflowe.com/api/ProductSummary/GetSummaryItemHistory"
const DETAIL_BASE = "https://logistics.oneflowe.com/api/OrderDetailController"
const SOURCE = resolve("updatedReports/orderPurchaseReport.json")
const OUTPUT = resolve("updatedReports/ke-unresolved-item-prices-13-live-audit-2026-08-03.json")

function normalize(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/[\u2018\u2019]/g, "'").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim().toLowerCase()
}

function normalizeProduct(value: unknown): string {
  return normalize(value).replace(/\s*\(\s*/g, " (").replace(/\s*\)\s*/g, ")").replace(/\s*-\s*/g, "-")
}

function dateKey(value: unknown): string {
  const match = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})/)
  if (!match) throw new Error(`Invalid date: ${String(value)}`)
  return match[1]
}

function cents(value: unknown): number {
  return Math.round((Number(value ?? 0) + Number.EPSILON) * 100)
}

async function request(url: string, init?: RequestInit): Promise<any> {
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" || parsed.hostname !== "logistics.oneflowe.com") throw new Error(`Safety guard rejected ${url}`)
  if (init?.method && !["GET", "POST"].includes(init.method)) throw new Error(`Safety guard rejected ${init.method}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: "follow" })
    const text = await response.text()
    if (!response.ok) throw new Error(`${url} returned ${response.status}: ${text.slice(0, 240)}`)
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const allRows = JSON.parse(readFileSync(SOURCE, "utf8")) as Row[]
  const rowsById = new Map<number, Row[]>()
  for (const row of allRows) {
    const id = Number(row.ID)
    if (!IDS.includes(id)) continue
    rowsById.set(id, [...(rowsById.get(id) ?? []), row])
  }
  const orders: Row[] = []
  const lines: Row[] = []
  const rawResponses: Row[] = []
  for (const legacyOrderId of IDS) {
    const sourceLines = rowsById.get(legacyOrderId)
    if (!sourceLines?.length) throw new Error(`Missing export rows for ${legacyOrderId}`)
    const first = sourceLines[0]
    const locationId = Number(first.LocationID)
    const orderDate = dateKey(first.OrderCreatedDT)
    const payload = { StartDate: orderDate, EndDate: orderDate, LocationIDs: locationId, LocationGroupIDs: null, UserID: 1, Timezone: null }
    const [history, detail] = await Promise.all([
      request(HISTORY_ENDPOINT, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
      request(`${DETAIL_BASE}/${locationId}/${legacyOrderId}`, { method: "GET", headers: { Accept: "application/json" } }),
    ])
    if (!Array.isArray(history) || !Array.isArray(detail?.OrderDetailsList)) throw new Error(`Unexpected live response for ${legacyOrderId}`)
    const detailLines = detail.OrderDetailsList as Row[]
    const checkout = detail.OrderCheckoutList?.[0]
    if (!checkout || detailLines.length !== sourceLines.length) throw new Error(`Live detail count mismatch for ${legacyOrderId}`)
    const pricesByName = new Map<string, Set<number>>()
    for (const row of history as Row[]) {
      if (dateKey(row.Date) !== orderDate || normalize(row.Location) !== normalize(first.Location)) continue
      const key = normalizeProduct(row.ItemName)
      const prices = pricesByName.get(key) ?? new Set<number>()
      prices.add(cents(row.Price))
      pricesByName.set(key, prices)
    }
    const evidence = detailLines.map((detailLine, index) => {
      const sourceLine = sourceLines[index]
      if (Number(sourceLine.ItemQuantity) !== Number(detailLine.Quantity)) throw new Error(`Quantity mismatch in ${legacyOrderId} line ${index + 1}`)
      const prices = [...(pricesByName.get(normalizeProduct(detailLine.Name)) ?? [])]
      const historyPriceCents = prices.length === 1 ? prices[0] : null
      const quantity = Number(detailLine.Quantity)
      const detailTotalCents = cents(detailLine.Price)
      const rawPriceCents = cents(sourceLine.UnitPrice)
      const historyTotalCents = historyPriceCents == null ? null : historyPriceCents * quantity
      const row = {
        legacyOrderId,
        lineNumber: index + 1,
        liveItemId: Number(detailLine.ItemId),
        exportedName: String(sourceLine.ItemDetails),
        liveDetailName: String(detailLine.Name),
        nameChangedOrTruncated: normalizeProduct(sourceLine.ItemDetails) !== normalizeProduct(detailLine.Name),
        quantity,
        exportedUnitPriceCents: rawPriceCents,
        liveHistoryUnitPriceCents: historyPriceCents,
        liveDetailLineTotalCents: detailTotalCents,
        liveHistoryLineTotalCents: historyTotalCents,
        exactHistoryPricesFound: prices.length,
        exportedPriceDiffers: historyPriceCents != null && historyPriceCents !== rawPriceCents,
        detailMatchesHistory: historyTotalCents === detailTotalCents,
      }
      lines.push(row)
      return row
    })
    const headerCents = cents(first.AmountTotal)
    const rawCents = sourceLines.reduce((sum, row) => sum + cents(row.UnitPrice) * Number(row.ItemQuantity), 0)
    const detailCents = detailLines.reduce((sum, row) => sum + cents(row.Price), 0)
    const historyComplete = evidence.every((row) => row.exactHistoryPricesFound === 1)
    const historyCents = historyComplete ? evidence.reduce((sum, row) => sum + Number(row.liveHistoryLineTotalCents), 0) : null
    const nowResolved = detailCents === headerCents && historyCents === headerCents && evidence.every((row) => row.detailMatchesHistory)
    orders.push({
      legacyOrderId,
      locationId,
      branch: String(first.Location),
      orderDate,
      itemLines: sourceLines.length,
      headerSubtotalCents: headerCents,
      exportedLinesSubtotalCents: rawCents,
      exportedDifferenceCents: rawCents - headerCents,
      liveDetailSubtotalCents: detailCents,
      liveHistorySubtotalCents: historyCents,
      changedPriceLines: evidence.filter((row) => row.exportedPriceDiffers).length,
      renamedOrTruncatedLines: evidence.filter((row) => row.nameChangedOrTruncated).length,
      unresolvedLiveHistoryLines: evidence.filter((row) => row.exactHistoryPricesFound !== 1).length,
      statusId: Number(detail.StatusID),
      deliveryStatus: Number(detail.DeliveryStatus),
      refundAmount: Number(checkout.RefundAmount ?? 0),
      nowResolved,
      originalClassificationExplanation: rawCents === headerCents
        ? "The flat export added correctly, but the older cross-report evidence contained conflicting prices, so the conservative importer refused to choose a price source."
        : "The flat export's item prices did not add to the header, and the older cross-report evidence could not isolate a single authoritative replacement price.",
    })
    rawResponses.push({ legacyOrderId, request: payload, history, detail })
    process.stdout.write(`Audited ${legacyOrderId}: ${history.length} history rows, ${detailLines.length} detail rows\n`)
  }

  const result = {
    generatedAt: new Date().toISOString(),
    safety: {
      sourceMode: "READ_ONLY",
      endpoints: [HISTORY_ENDPOINT, `${DETAIL_BASE}/{LocationID}/{OrderID}`],
      mutationsIssued: 0,
      productionDatabaseChanges: 0,
    },
    legacyOrderIds: IDS,
    summary: {
      orders: IDS.length,
      itemLines: lines.length,
      previouslyRawSubtotalMatched: orders.filter((row) => row.exportedDifferenceCents === 0).length,
      previouslyRawSubtotalMismatched: orders.filter((row) => row.exportedDifferenceCents !== 0).length,
      nowResolvedByLiveDetailAndHistory: orders.filter((row) => row.nowResolved).length,
      stillUnresolved: orders.filter((row) => !row.nowResolved).length,
      changedExportPriceLines: lines.filter((row) => row.exportedPriceDiffers).length,
      renamedOrTruncatedLines: lines.filter((row) => row.nameChangedOrTruncated).length,
    },
    orders,
    lines,
    rawResponses,
  }
  const text = `${JSON.stringify(result, null, 2)}\n`
  writeFileSync(OUTPUT, text, "utf8")
  console.log(JSON.stringify({ output: OUTPUT, sha256: createHash("sha256").update(text).digest("hex"), summary: result.summary }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
