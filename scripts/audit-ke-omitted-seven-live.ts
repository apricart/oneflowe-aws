#!/usr/bin/env tsx
import { stringifyPrimitive } from "../lib/stringify-primitive"

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

type Row = Record<string, any>

const BASE = "https://logistics.oneflowe.com/"
const OUTPUT = resolve("updatedReports/ke-omitted-from-updated-exports-7-live-audit-2026-08-03.json")
const ORDERS = [
  { legacyOrderId: 1168, branch: "HQ (75-B) Security", orderNo: 2, transactionNo: 14, priorStatusId: 1, priorDeliveryStatus: 501, priorDate: "2026-07-03" },
  { legacyOrderId: 1169, branch: "HQ (75-B) Security", orderNo: 3, transactionNo: 15, priorStatusId: 1, priorDeliveryStatus: 501, priorDate: "2026-07-03" },
  { legacyOrderId: 1170, branch: "HQ (75-B) Security", orderNo: 4, transactionNo: 16, priorStatusId: 1, priorDeliveryStatus: 501, priorDate: "2026-07-03" },
  { legacyOrderId: 1171, branch: "HQ (75-B) Security", orderNo: 5, transactionNo: 17, priorStatusId: 1, priorDeliveryStatus: 501, priorDate: "2026-07-03" },
  { legacyOrderId: 1172, branch: "HQ (75-B) Security", orderNo: 6, transactionNo: 18, priorStatusId: 1, priorDeliveryStatus: 501, priorDate: "2026-07-03" },
  { legacyOrderId: 1173, branch: "HQ (75-B) Security", orderNo: 7, transactionNo: 19, priorStatusId: 1, priorDeliveryStatus: 501, priorDate: "2026-07-03" },
  { legacyOrderId: 1184, branch: "CHSEQ", orderNo: 1, transactionNo: 11, priorStatusId: 1, priorDeliveryStatus: 501, priorDate: "2026-07-09" },
]

function normalize(value: unknown): string { return stringifyPrimitive(value).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase() }

async function get(pathname: string) {
  const url = new URL(pathname, BASE)
  if (url.protocol !== "https:" || url.hostname !== "logistics.oneflowe.com") throw new Error(`Safety guard rejected ${url}`)
  const started = Date.now()
  const response = await fetch(url, { method: "GET", redirect: "follow", headers: { Accept: "application/json, text/plain, */*" } })
  const text = await response.text()
  let data: any = text
  try {
    data = text ? JSON.parse(text) : null
  } catch (error) {
    console.warn(`Unable to parse response from ${url}:`, error)
  }
  return { ok: response.ok, status: response.status, durationMs: Date.now() - started, data }
}

async function main() {
  const locationsResponse = await get("api/Location/GetLocation/1")
  if (!locationsResponse.ok || !Array.isArray(locationsResponse.data)) throw new Error("Location lookup failed")
  const locations = locationsResponse.data as Row[]
  const resolved = ORDERS.map((order) => {
    const matches = locations.filter((location) => normalize(location.Name) === normalize(order.branch))
    if (matches.length !== 1) throw new Error(`${order.branch} matched ${matches.length} locations`)
    return { ...order, locationId: Number(matches[0].ID) }
  })
  const openByLocation = new Map<number, any>()
  for (const locationId of new Set(resolved.map((row) => row.locationId))) {
    openByLocation.set(locationId, await get(`api/OrderController/GetOrders/${locationId}`))
  }
  const results: Row[] = []
  for (const order of resolved) {
    const detail = await get(`api/OrderDetailController/${order.locationId}/${order.legacyOrderId}`)
    const openResponse = openByLocation.get(order.locationId)
    const openOrders = Array.isArray(openResponse?.data) ? openResponse.data : []
    const openMatch = openOrders.filter((row: Row) => Number(row.ID) === order.legacyOrderId)
    const detailData = detail.data && typeof detail.data === "object" && !Array.isArray(detail.data) ? detail.data : null
    const detailItems = Array.isArray(detailData?.OrderDetailsList) ? detailData.OrderDetailsList : []
    const checkouts = Array.isArray(detailData?.OrderCheckoutList) ? detailData.OrderCheckoutList : []
    results.push({
      ...order,
      detailHttpStatus: detail.status,
      detailReturnedObject: Boolean(detailData),
      detailId: detailData?.ID ?? null,
      detailStatusId: detailData?.StatusID ?? null,
      detailDeliveryStatus: detailData?.DeliveryStatus ?? null,
      detailItemRows: detailItems.length,
      detailCheckoutRows: checkouts.length,
      foundInCurrentOpenOrders: openMatch.length === 1,
      currentOpenOrderMatches: openMatch,
      rawDetail: detail.data,
    })
    process.stdout.write(`Audited ${order.legacyOrderId}: detail ${detail.status}, items ${detailItems.length}, open matches ${openMatch.length}\n`)
  }
  const latestSnapshot = JSON.parse(readFileSync(resolve("backups/ke-import-state-2026-08-03-post-live-resolved-13-orders.json"), "utf8")) as Row
  const importedIds = new Set((latestSnapshot.legacyOrderImports as Row[]).map((row) => Number(row.legacy_order_id)))
  const report = {
    generatedAt: new Date().toISOString(),
    safety: { mode: "READ_ONLY", mutationsIssued: 0, productionDatabaseChanges: 0 },
    summary: {
      orders: results.length,
      priorPlacedNotDelivered: results.filter((row) => row.priorStatusId === 1 && row.priorDeliveryStatus === 501).length,
      liveDetailObjects: results.filter((row) => row.detailReturnedObject && Number(row.detailId) > 0).length,
      liveDetailItemRows: results.reduce((sum, row) => sum + row.detailItemRows, 0),
      currentOpenOrderMatches: results.filter((row) => row.foundInCurrentOpenOrders).length,
      alreadyImportedToProduction: results.filter((row) => importedIds.has(row.legacyOrderId)).length,
    },
    locations: resolved.map((row) => ({ branch: row.branch, locationId: row.locationId })),
    openOrderResponses: Object.fromEntries(openByLocation),
    orders: results,
  }
  const text = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(OUTPUT, text, "utf8")
  console.log(JSON.stringify({ output: OUTPUT, sha256: createHash("sha256").update(text).digest("hex"), summary: report.summary }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
