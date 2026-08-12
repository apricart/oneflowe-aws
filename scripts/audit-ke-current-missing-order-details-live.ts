#!/usr/bin/env tsx
import { stringifyPrimitive } from "../lib/stringify-primitive"

import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import * as XLSX from "xlsx"

type Row = Record<string, any>

const BASE = "https://logistics.oneflowe.com/"
const INPUT = resolve("updatedReports/ke-current-missing-orders-excluding-cancelled-2026-08-03.xlsx")
const OUTPUT = resolve("updatedReports/ke-current-missing-orders-live-detail-audit-2026-08-04.json")

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

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function cents(value: unknown): number {
  return Math.round((Number(value ?? 0) + Number.EPSILON) * 100)
}

function dateKey(value: unknown): string | null {
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (!parsed) return null
    return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(stringifyPrimitive(value))
  return match?.[1] ?? null
}

async function request(pathname: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; durationMs: number; data: any }> {
  const url = new URL(pathname, BASE)
  if (url.protocol !== "https:" || url.hostname !== "logistics.oneflowe.com") throw new Error(`Safety guard rejected ${url}`)
  const method = String(init.method ?? "GET").toUpperCase()
  if (!['GET', 'POST'].includes(method)) throw new Error(`Safety guard rejected method ${method}`)
  if (method === "POST" && url.pathname !== "/api/ProductSummary/GetSummaryItemHistory") throw new Error(`Safety guard rejected POST ${url.pathname}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45_000)
  const started = Date.now()
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: "application/json, text/plain, */*", ...(init.headers ?? {}) },
    })
    const text = await response.text()
    let data: any = text
    try {
      data = text ? JSON.parse(text) : null
    } catch (error) {
      console.warn(`Unable to parse response from ${url}:`, error)
    }
    return { ok: response.ok, status: response.status, durationMs: Date.now() - started, data }
  } finally {
    clearTimeout(timer)
  }
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, fn: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  async function worker() {
    for (;;) {
      const index = next++
      if (index >= values.length) return
      results[index] = await fn(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return results
}

function compactCheckout(value: any): Row | null {
  if (!value || typeof value !== "object") return null
  return {
    ID: value.ID,
    OrderID: value.OrderID,
    LocationID: value.LocationID,
    TransactionNo: value.TransactionNo,
    OrderNo: value.OrderNo,
    PaymentMode: value.PaymentMode,
    AmountTotal: numberOrNull(value.AmountTotal),
    AmountDiscount: numberOrNull(value.AmountDiscount),
    ItemDiscountAmount: numberOrNull(value.ItemDiscountAmount),
    Tax: numberOrNull(value.Tax),
    GrandTotal: numberOrNull(value.GrandTotal),
    RefundAmount: numberOrNull(value.RefundAmount),
    TaxRefund: numberOrNull(value.TaxRefund),
    ServiceCharges: numberOrNull(value.ServiceCharges),
    DeliveryCharges: numberOrNull(value.DeliveryCharges),
    CheckoutDate: value.CheckoutDate,
    OrderStatus: value.OrderStatus,
  }
}

function compactItem(value: any): Row {
  return {
    ID: value.ID,
    OrderID: value.OrderID,
    ItemId: value.ItemId,
    Name: value.Name,
    Quantity: numberOrNull(value.Quantity),
    RefundQuantity: numberOrNull(value.RefundQuantity),
    Price: numberOrNull(value.Price),
    UnitPrice: numberOrNull(value.UnitPrice),
    RefundPrice: numberOrNull(value.RefundPrice),
    DiscountPrice: numberOrNull(value.DiscountPrice),
    RefundDiscountPrice: numberOrNull(value.RefundDiscountPrice),
    PriceWithVAT: numberOrNull(value.PriceWithVAT),
    ItemCode: value.ItemCode,
    StatusID: value.StatusID,
    ItemType: value.ItemType,
    CategoryName: value.CategoryName,
  }
}

async function main() {
  const workbook = XLSX.readFile(INPUT, { cellDates: false })
  const rows = XLSX.utils.sheet_to_json<Row>(workbook.Sheets["Missing Orders"], { defval: null, raw: true })
  if (rows.length !== 28) throw new Error(`Expected 28 orders, found ${rows.length}`)
  if (rows.some((row) => normalize(row["Current Interpretation"]) === "cancelled")) throw new Error("Cancelled order entered audit scope")

  const locationsResponse = await request("api/Location/GetLocation/1")
  if (!locationsResponse.ok || !Array.isArray(locationsResponse.data)) throw new Error(`Location request failed: ${locationsResponse.status}`)
  const locations = locationsResponse.data as Row[]
  const scopes = rows.map((row) => {
    const matches = locations.filter((location) => normalize(location.Name) === normalize(row["Branch / Location"]))
    if (matches.length !== 1) throw new Error(`Location '${row["Branch / Location"]}' matched ${matches.length} rows`)
    return { row, legacyOrderId: Number(row["Legacy Order ID"]), locationId: Number(matches[0].ID), branch: String(matches[0].Name) }
  })

  const orders = await mapConcurrent(scopes, 4, async (scope) => {
    const detailResponse = await request(`api/OrderDetailController/${scope.locationId}/${scope.legacyOrderId}`)
    const detail = detailResponse.data && typeof detailResponse.data === "object" && !Array.isArray(detailResponse.data) ? detailResponse.data : null
    const realDetail = Boolean(detail && Number(detail.ID) === scope.legacyOrderId)
    const items: Row[] = realDetail && Array.isArray(detail.OrderDetailsList) ? detail.OrderDetailsList.map(compactItem) : []
    const checkouts = realDetail && Array.isArray(detail.OrderCheckoutList) ? detail.OrderCheckoutList.map(compactCheckout).filter(Boolean) : []
    const checkout = checkouts[0] ?? null
    const liveDate = dateKey(detail?.OrderCreatedDT) ?? dateKey(scope.row["Order Date"])
    let historyResponse: Awaited<ReturnType<typeof request>> | null = null
    if (realDetail && liveDate) {
      const body = { StartDate: liveDate, EndDate: liveDate, LocationIDs: scope.locationId, LocationGroupIDs: null, UserID: 1, Timezone: null }
      historyResponse = await request("api/ProductSummary/GetSummaryItemHistory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    }
    let refundModalResponse: Awaited<ReturnType<typeof request>> | null = null
    const liveCheckout = checkouts[0] ?? null
    const liveRefundEvidence = scope.row["Blocker Code"] === "HAS_REFUND_EVIDENCE"
      || Number(liveCheckout?.RefundAmount ?? 0) > 0
      || Number(detail?.StatusID) === 4
    if (liveRefundEvidence) {
      refundModalResponse = await request(`api/RefundModal/${scope.locationId}/${encodeURIComponent(String(scope.row["Transaction No"]))}`)
    }

    const history = Array.isArray(historyResponse?.data) ? historyResponse!.data as Row[] : []
    const exactHistoryByName = new Map<string, Set<number>>()
    for (const row of history) {
      if (dateKey(row.Date) !== liveDate || normalize(row.Location) !== normalize(scope.branch)) continue
      const set = exactHistoryByName.get(normalizeProduct(row.ItemName)) ?? new Set<number>()
      set.add(cents(row.Price))
      exactHistoryByName.set(normalizeProduct(row.ItemName), set)
    }
    const itemEvidence: Row[] = items.map((item, index) => {
      const prices = [...(exactHistoryByName.get(normalizeProduct(item.Name)) ?? [])]
      const selectedHistoryPriceCents = prices.length === 1 ? prices[0] : null
      const quantity = Number(item.Quantity ?? 0)
      const detailLineTotalCents = cents(item.Price)
      return {
        legacyOrderId: scope.legacyOrderId,
        lineNumber: index + 1,
        ...item,
        exactHistoryPricesCents: prices,
        exactHistoryPriceCount: prices.length,
        selectedHistoryUnitPriceCents: selectedHistoryPriceCents,
        selectedHistoryLineTotalCents: selectedHistoryPriceCents == null ? null : selectedHistoryPriceCents * quantity,
        historyMatchesDetail: selectedHistoryPriceCents != null && selectedHistoryPriceCents * quantity === detailLineTotalCents,
        zeroQuantityZeroValueArtifact: quantity === 0 && detailLineTotalCents === 0,
      }
    })
    const detailSubtotalCents = itemEvidence.reduce((sum, item) => sum + cents(item.Price), 0)
    const checkoutSubtotalCents = checkout ? cents(checkout.AmountTotal) : null
    const historyComplete = itemEvidence.length > 0 && itemEvidence.filter((item) => Number(item.Quantity) > 0).every((item) => item.exactHistoryPriceCount === 1 && item.historyMatchesDetail)
    const positiveItems = itemEvidence.filter((item) => Number(item.Quantity) > 0)
    const zeroItems = itemEvidence.filter((item) => Number(item.Quantity) === 0)
    const detailStatusText = String(checkout?.OrderStatus ?? detail?.OrderStatus ?? scope.row["Updated Order Status"] ?? "")
    const explicitlyPartial = normalize(detailStatusText).includes("partial") || Number(detail?.DeliveryStatus) === 505
    const finalDelivered = Number(detail?.StatusID) === 2 && Number(detail?.DeliveryStatus) === 507
    const policyDelivered = realDetail && (finalDelivered || explicitlyPartial)
    const subtotalReconciles = checkoutSubtotalCents != null && detailSubtotalCents === checkoutSubtotalCents
    const allZeroLinesAreArtifacts = zeroItems.every((item) => item.zeroQuantityZeroValueArtifact)
    const isRefund = liveRefundEvidence
    const normalOrderEvidenceComplete = realDetail && policyDelivered && !isRefund && positiveItems.length > 0 && subtotalReconciles && historyComplete && allZeroLinesAreArtifacts && Boolean(checkout)

    process.stdout.write(`Audited ${scope.legacyOrderId}: detail=${realDetail ? "real" : "empty"}, status=${detail?.StatusID ?? "-"}/${detail?.DeliveryStatus ?? "-"}, items=${items.length}, refund=${isRefund ? "yes" : "no"}\n`)
    return {
      legacyOrderId: scope.legacyOrderId,
      originalBlockerCode: scope.row["Blocker Code"],
      branch: scope.branch,
      locationId: scope.locationId,
      reportOrderNo: scope.row["Order No"],
      reportTransactionNo: scope.row["Transaction No"],
      reportStatusId: scope.row.StatusID,
      reportDeliveryStatus: scope.row.DeliveryStatus,
      reportStatusText: scope.row["Updated Order Status"] || scope.row["Current Interpretation"],
      detailHttpStatus: detailResponse.status,
      realDetail,
      detailHeader: realDetail ? {
        ID: detail.ID,
        LocationID: detail.LocationID,
        Location: detail.Location,
        TransactionNo: detail.TransactionNo,
        OrderNo: detail.OrderNo,
        StatusID: detail.StatusID,
        DeliveryStatus: detail.DeliveryStatus,
        OrderStatus: detail.OrderStatus,
        OrderCreatedDT: detail.OrderCreatedDT,
        OrderUpdatedDT: detail.OrderUpdatedDT,
        OrderType: detail.OrderType,
        UserID: detail.UserID,
        UserName: detail.UserName ?? detail.UserDetails,
      } : null,
      liveDate,
      checkout,
      checkoutRows: checkouts.length,
      itemRows: items.length,
      positiveItemRows: positiveItems.length,
      zeroQuantityItemRows: zeroItems.length,
      zeroQuantityZeroValueArtifactRows: zeroItems.filter((item) => item.zeroQuantityZeroValueArtifact).length,
      detailSubtotalCents,
      checkoutSubtotalCents,
      subtotalReconciles,
      historyHttpStatus: historyResponse?.status ?? null,
      historyRows: history.length,
      historyComplete,
      detailStatusText,
      finalDelivered,
      explicitlyPartial,
      userPolicyAcceptedAsDelivered: explicitlyPartial,
      policyDelivered,
      refundEvidence: isRefund,
      normalOrderEvidenceComplete,
      itemEvidence,
      refundModal: refundModalResponse ? {
        httpStatus: refundModalResponse.status,
        ok: refundModalResponse.ok,
        itemRows: Array.isArray(refundModalResponse.data?.OrderDetailsList) ? refundModalResponse.data.OrderDetailsList.map(compactItem) : [],
        raw: refundModalResponse.data,
      } : null,
      rawDetail: detailResponse.data,
      rawHistory: historyResponse?.data ?? null,
    }
  })

  const result = {
    generatedAt: new Date().toISOString(),
    organization: { id: 10, code: "0001", name: "K-Electric" },
    policy: {
      partialDelivery: "Treat explicit Partial / DeliveryStatus 505 as delivered for this remaining-order review.",
      excludedStatuses: "In Process, Out For Delivery, Order Placed, cancelled, missing/empty records, and other non-final statuses are not promoted.",
    },
    safety: {
      mode: "READ_ONLY",
      getEndpoints: ["api/Location/GetLocation/1", "api/OrderDetailController/{LocationID}/{OrderID}", "api/RefundModal/{LocationID}/{TransactionNo}"],
      readOnlyPostEndpoint: "api/ProductSummary/GetSummaryItemHistory",
      sourceMutationsIssued: 0,
      productionDatabaseChanges: 0,
    },
    summary: {
      orders: orders.length,
      realDetails: orders.filter((order) => order.realDetail).length,
      emptyDetails: orders.filter((order) => !order.realDetail).length,
      finalDelivered: orders.filter((order) => order.finalDelivered).length,
      explicitPartialAccepted: orders.filter((order) => order.explicitlyPartial).length,
      nonFinalNotAccepted: orders.filter((order) => order.realDetail && !order.policyDelivered && !order.refundEvidence).length,
      refundEvidenceOrders: orders.filter((order) => order.refundEvidence).length,
      normalOrderEvidenceComplete: orders.filter((order) => order.normalOrderEvidenceComplete).length,
      zeroQuantityArtifactOrders: orders.filter((order) => order.zeroQuantityItemRows > 0 && order.zeroQuantityItemRows === order.zeroQuantityZeroValueArtifactRows).length,
    },
    orders,
  }
  const text = `${JSON.stringify(result, null, 2)}\n`
  writeFileSync(OUTPUT, text, "utf8")
  console.log(JSON.stringify({ output: OUTPUT, sha256: createHash("sha256").update(text).digest("hex"), summary: result.summary }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
