#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import * as XLSX from "xlsx"

type Row = Record<string, any>

const REPORT_DATE = "2026-08-03"
const ENDPOINT = "https://logistics.oneflowe.com/api/ProductSummary/GetSummaryItemHistory"
const DETAIL_BASE = "https://logistics.oneflowe.com/api/OrderDetailController"
const EXPECTED_HOST = "logistics.oneflowe.com"
const EXPECTED_PATH = "/api/ProductSummary/GetSummaryItemHistory"
const USER_ID = 1
const REMAINING_REPORT = resolve("updatedReports/ke-remaining-orders-report-2026-07-23.json")
const ORDER_LINES = resolve("updatedReports/orderPurchaseReport.json")
const RAW_OUTPUT = resolve(`updatedReports/ke-live-item-price-history-mismatch-orders-${REPORT_DATE}.json`)
const ANALYSIS_OUTPUT = resolve(`updatedReports/ke-subtotal-live-price-history-reconciliation-${REPORT_DATE}.json`)
const EXCEL_OUTPUT = resolve(`updatedReports/ke-subtotal-live-price-history-reconciliation-${REPORT_DATE}.xlsx`)

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function normalizeProductName(value: unknown): string {
  return normalizeText(value)
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s*\)\s*/g, ")")
    .replace(/\s*-\s*/g, "-")
}

function dateKey(value: unknown): string {
  const raw = String(value ?? "")
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  if (match) return match[1]
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${raw}`)
  return parsed.toISOString().slice(0, 10)
}

function toCents(value: unknown): number {
  const parsed = Number(value ?? 0)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid monetary value: ${String(value)}`)
  return Math.round((parsed + Number.EPSILON) * 100)
}

function money(cents: number | null): number | null {
  return cents == null ? null : cents / 100
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function assertReadOnlyReportEndpoint() {
  const url = new URL(ENDPOINT)
  if (url.protocol !== "https:" || url.hostname !== EXPECTED_HOST || url.pathname !== EXPECTED_PATH) {
    throw new Error(`Safety guard rejected endpoint: ${ENDPOINT}`)
  }
}

function detailUrl(locationId: number, legacyOrderId: number): string {
  const url = new URL(`${DETAIL_BASE}/${locationId}/${legacyOrderId}`)
  if (url.protocol !== "https:" || url.hostname !== EXPECTED_HOST || !url.pathname.startsWith("/api/OrderDetailController/")) {
    throw new Error(`Safety guard rejected detail endpoint: ${url}`)
  }
  return url.toString()
}

async function fetchHistory(locationId: number, orderDate: string): Promise<Row[]> {
  assertReadOnlyReportEndpoint()
  const payload = {
    StartDate: orderDate,
    EndDate: orderDate,
    LocationIDs: locationId,
    LocationGroupIDs: null,
    UserID: USER_ID,
    Timezone: null,
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`Price-history query returned ${response.status}: ${text.slice(0, 300)}`)
    const data = JSON.parse(text)
    if (!Array.isArray(data)) throw new Error("Price-history response was not an array")
    return data
  } finally {
    clearTimeout(timer)
  }
}

async function fetchOrderDetail(locationId: number, legacyOrderId: number): Promise<Row> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(detailUrl(locationId, legacyOrderId), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: "application/json, text/plain, */*" },
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`Order-detail query returned ${response.status}: ${text.slice(0, 300)}`)
    const data = JSON.parse(text)
    if (!data || typeof data !== "object" || !Array.isArray(data.OrderDetailsList)) {
      throw new Error(`Order ${legacyOrderId} detail response had an unexpected shape`)
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

function autoWidth(rows: Row[], headers: string[]): XLSX.ColInfo[] {
  return headers.map((header) => ({
    wch: Math.min(72, Math.max(11, header.length + 2, ...rows.slice(0, 500).map((row) => String(row[header] ?? "").length + 2))),
  }))
}

function addSheet(workbook: XLSX.WorkBook, name: string, rows: Row[], moneyHeaders: string[] = []) {
  if (rows.length === 0) throw new Error(`Cannot create empty sheet: ${name}`)
  const headers = Object.keys(rows[0])
  const sheet = XLSX.utils.json_to_sheet(rows, { header: headers })
  sheet["!cols"] = autoWidth(rows, headers)
  sheet["!autofilter"] = {
    ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }),
  }
  sheet["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" } as any
  const moneyColumns = new Set(moneyHeaders.map((header) => headers.indexOf(header)).filter((index) => index >= 0))
  for (let rowIndex = 1; rowIndex <= rows.length; rowIndex += 1) {
    for (const columnIndex of moneyColumns) {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })]
      if (cell && cell.t === "n") cell.z = "#,##0.00;[Red]-#,##0.00"
    }
  }
  XLSX.utils.book_append_sheet(workbook, sheet, name)
}

async function main() {
  const remaining = readJson<{ categories: Array<{ code: string; legacyOrderIds: number[] }> }>(REMAINING_REPORT)
  const category = remaining.categories.find((item) => item.code === "ITEM_SUBTOTAL_MISMATCH")
  if (!category || category.legacyOrderIds.length !== 19) throw new Error("Expected exactly 19 subtotal-mismatch IDs")
  const mismatchIds = [...category.legacyOrderIds].map(Number).sort((a, b) => a - b)
  const mismatchSet = new Set(mismatchIds)
  const sourceLines = readJson<Row[]>(ORDER_LINES).filter((row) => mismatchSet.has(Number(row.ID)))

  const linesByOrder = new Map<number, Row[]>()
  for (const line of sourceLines) {
    const id = Number(line.ID)
    linesByOrder.set(id, [...(linesByOrder.get(id) ?? []), line])
  }
  const missingOrders = mismatchIds.filter((id) => !linesByOrder.has(id))
  if (missingOrders.length > 0) throw new Error(`Missing source lines for orders: ${missingOrders.join(", ")}`)

  const queries = mismatchIds.map((legacyOrderId) => {
    const header = linesByOrder.get(legacyOrderId)![0]
    return {
      legacyOrderId,
      locationId: Number(header.LocationID),
      location: String(header.Location ?? ""),
      orderDate: dateKey(header.OrderCreatedDT),
    }
  })

  const rawQueries: Array<Row> = []
  for (const query of queries) {
    const rows = await fetchHistory(query.locationId, query.orderDate)
    const orderDetail = await fetchOrderDetail(query.locationId, query.legacyOrderId)
    rawQueries.push({
      ...query,
      request: {
        StartDate: query.orderDate,
        EndDate: query.orderDate,
        LocationIDs: query.locationId,
        LocationGroupIDs: null,
        UserID: USER_ID,
        Timezone: null,
      },
      rowCount: rows.length,
      rows,
      orderDetail,
    })
    process.stdout.write(`Fetched order ${query.legacyOrderId}: ${rows.length} history rows, ${orderDetail.OrderDetailsList.length} detail rows\n`)
  }

  const rawArtifact = {
    generatedAt: new Date().toISOString(),
    safety: {
      sourceMode: "READ_ONLY_REPORT_QUERY",
      endpoint: ENDPOINT,
      relatedOrderDetailEndpoint: `${DETAIL_BASE}/{LocationID}/{OrderID}`,
      httpMethods: ["POST (price-history report query)", "GET (individual order detail)"],
      mutationsIssued: 0,
      credentialsSent: false,
      note: "This POST is the exact report query used by ItemPriceHistoryCtrl; it reads report data and does not update source records.",
    },
    queryCount: rawQueries.length,
    queries: rawQueries,
  }
  const rawText = `${JSON.stringify(rawArtifact, null, 2)}\n`
  writeFileSync(RAW_OUTPUT, rawText, "utf8")

  const orderRows: Row[] = []
  const lineRows: Row[] = []
  let exactHistoryReconciliations = 0
  let exactDetailReconciliations = 0
  let completeHistoryMismatches = 0
  let incompleteHistoryOrders = 0
  let rawLineMatches = 0
  let rawLineMismatches = 0

  for (const query of rawQueries) {
    const legacyOrderId = Number(query.legacyOrderId)
    const lines = linesByOrder.get(legacyOrderId)!
    const header = lines[0]
    const historyRows = query.rows as Row[]
    const orderDetail = query.orderDetail as Row
    const detailItems = orderDetail.OrderDetailsList as Row[]
    const checkout = Array.isArray(orderDetail.OrderCheckoutList) ? orderDetail.OrderCheckoutList[0] : null
    if (detailItems.length !== lines.length) {
      throw new Error(`Order ${legacyOrderId} has ${lines.length} export lines but ${detailItems.length} live detail lines`)
    }
    const pricesByName = new Map<string, Set<number>>()
    for (const row of historyRows) {
      if (dateKey(row.Date) !== query.orderDate) continue
      if (normalizeText(row.Location) !== normalizeText(query.location)) continue
      const name = normalizeProductName(row.ItemName)
      const values = pricesByName.get(name) ?? new Set<number>()
      values.add(toCents(row.Price))
      pricesByName.set(name, values)
    }

    const headerCents = toCents(header.AmountTotal)
    const detailHeaderCents = checkout ? toCents(checkout.AmountTotal) : null
    if (detailHeaderCents !== headerCents) {
      throw new Error(`Order ${legacyOrderId} export/detail headers disagree: ${headerCents} vs ${detailHeaderCents}`)
    }
    const rawSubtotalCents = lines.reduce((sum, line) => sum + toCents(line.UnitPrice) * Number(line.ItemQuantity), 0)
    const detailSubtotalCents = detailItems.reduce((sum, item) => sum + toCents(item.Price), 0)
    const evidence = detailItems.map((detailItem, index) => {
      const line = lines[index]
      const name = normalizeProductName(detailItem.Name)
      const values = [...(pricesByName.get(name) ?? [])].sort((a, b) => a - b)
      const historyPriceCents = values.length === 1 ? values[0] : null
      const quantity = Number(detailItem.Quantity)
      const exportedQuantity = Number(line.ItemQuantity)
      if (quantity !== exportedQuantity) {
        throw new Error(`Order ${legacyOrderId} line ${index + 1} quantity differs between export and live detail`)
      }
      const rawPriceCents = toCents(line.UnitPrice)
      const detailLineTotalCents = toCents(detailItem.Price)
      const detailUnitPriceCents = quantity === 0 ? null : Math.round(detailLineTotalCents / quantity)
      return {
        index,
        line,
        detailItem,
        name,
        values,
        quantity,
        rawPriceCents,
        detailLineTotalCents,
        detailUnitPriceCents,
        historyPriceCents,
        rawLineTotalCents: rawPriceCents * quantity,
        historyLineTotalCents: historyPriceCents == null ? null : historyPriceCents * quantity,
      }
    })
    const unresolved = evidence.filter((item) => item.historyPriceCents == null)
    const historySubtotalCents = unresolved.length === 0
      ? evidence.reduce((sum, item) => sum + item.historyLineTotalCents!, 0)
      : null
    const historyMatchesHeader = historySubtotalCents === headerCents
    const detailMatchesHeader = detailSubtotalCents === headerCents
    const rawMatchesHeader = rawSubtotalCents === headerCents
    if (historyMatchesHeader) exactHistoryReconciliations += 1
    else if (historySubtotalCents == null) incompleteHistoryOrders += 1
    else completeHistoryMismatches += 1
    if (rawMatchesHeader) rawLineMatches += 1
    else rawLineMismatches += 1
    if (detailMatchesHeader) exactDetailReconciliations += 1

    const changedPriceLines = evidence.filter((item) => item.historyPriceCents != null && item.historyPriceCents !== item.rawPriceCents).length
    const renamedItemLines = evidence.filter((item) => normalizeProductName(item.line.ItemDetails) !== normalizeProductName(item.detailItem.Name)).length
    const classification = historyMatchesHeader
      ? "RECONCILED_BY_LIVE_DETAIL_AND_EXACT_HISTORY"
      : historySubtotalCents == null
        ? detailMatchesHeader ? "LIVE_DETAIL_RECONCILES; HISTORY_INCOMPLETE" : "LIVE_HISTORY_INCOMPLETE_OR_AMBIGUOUS"
        : rawMatchesHeader
          ? "RAW_ORDER_LINES_MATCH; LIVE_HISTORY_DIFFERS"
          : "COMPLETE_LIVE_HISTORY_STILL_MISMATCHES"
    const explanation = historyMatchesHeader
      ? `Confirmed price-change/versioning case: the live order-detail item IDs/names were joined to the exact branch/date Item Price History. Those dated prices add to the header subtotal. ${changedPriceLines} exported line price(s) and ${renamedItemLines} exported item name(s) differ from the live historical/detail evidence.`
      : historySubtotalCents == null
        ? `The live detail line totals ${detailMatchesHeader ? "do" : "do not"} add to the header, but the exact live price-history report did not return one unique dated price for ${unresolved.length} detail item(s).`
        : rawMatchesHeader
          ? "The order export's own line prices already add to the header. The live history snapshot differs, so historical price data should not replace the prices stored on this order."
          : "Even the complete exact-date, exact-branch live history does not add to the header subtotal; price history alone does not resolve this order."

    orderRows.push({
      "Legacy Order ID": legacyOrderId,
      "Location ID": Number(query.locationId),
      "Branch": query.location,
      "Order Date": query.orderDate,
      "Registration No": String(header.RegistrationNo ?? ""),
      "User": String(header.UserDetails ?? header.LastUpdateBy ?? ""),
      "Item Lines": lines.length,
      "Live History Rows": historyRows.length,
      "Live Detail Rows": detailItems.length,
      "Unresolved History Lines": unresolved.length,
      "Changed Price Lines": changedPriceLines,
      "Renamed Item Lines": renamedItemLines,
      "Header Subtotal PKR": money(headerCents),
      "Live Detail Header PKR": money(detailHeaderCents),
      "Live Detail Lines Sum PKR": money(detailSubtotalCents),
      "Raw Lines Sum PKR": money(rawSubtotalCents),
      "Raw Difference PKR": money(rawSubtotalCents - headerCents),
      "Live History Sum PKR": money(historySubtotalCents),
      "History Difference PKR": historySubtotalCents == null ? null : money(historySubtotalCents - headerCents),
      "Raw Lines Match Header": rawMatchesHeader ? "YES" : "No",
      "Live Detail Lines Match Header": detailMatchesHeader ? "YES" : "No",
      "Live History Matches Header": historyMatchesHeader ? "YES" : "No",
      "Classification": classification,
      "Explanation": explanation,
      "Recommended Import Decision": historyMatchesHeader || rawMatchesHeader
        ? "ELIGIBLE FOR A NEW DRY-RUN REVIEW; DO NOT AUTO-IMPORT"
        : "KEEP BLOCKED",
    })

    for (const item of evidence) {
      const historyDiff = item.historyPriceCents == null ? null : item.historyPriceCents - item.rawPriceCents
      const itemWasRenamed = normalizeProductName(item.line.ItemDetails) !== normalizeProductName(item.detailItem.Name)
      lineRows.push({
        "Legacy Order ID": legacyOrderId,
        "Line No": item.index + 1,
        "Location ID": Number(query.locationId),
        "Branch": query.location,
        "Order Date": query.orderDate,
        "Live Item ID": Number(item.detailItem.ItemId),
        "Exported Item Name": String(item.line.ItemDetails ?? ""),
        "Live Detail Item Name": String(item.detailItem.Name ?? ""),
        "Item Renamed/Truncated": itemWasRenamed ? "YES" : "No",
        "Quantity": item.quantity,
        "Raw Unit Price PKR": money(item.rawPriceCents),
        "Raw Line Total PKR": money(item.rawLineTotalCents),
        "Live Detail Unit Price PKR": money(item.detailUnitPriceCents),
        "Live Detail Line Total PKR": money(item.detailLineTotalCents),
        "Live History Price PKR": money(item.historyPriceCents),
        "Live History Line Total PKR": money(item.historyLineTotalCents),
        "Price Difference PKR": money(historyDiff),
        "Unique History Prices Found": item.values.length,
        "All History Prices PKR": item.values.map((value) => (value / 100).toFixed(2)).join(" | ") || "None",
        "Price Changed vs Exported Line": historyDiff === 0 ? "No" : historyDiff == null ? "Unknown" : "YES",
        "Detail Total Equals History x Quantity": item.historyLineTotalCents === item.detailLineTotalCents ? "YES" : "No",
        "Evidence Status": item.values.length === 1
          ? "Live ItemID/name -> exact branch/date history; export row aligned by position and identical quantity"
          : item.values.length === 0 ? "No exact live-history match for detail item name" : "Ambiguous exact live-history matches",
      })
    }
  }

  const rawHash = sha256(rawText)
  const summary = {
    orders: mismatchIds.length,
    itemLines: sourceLines.length,
    exactHistoryReconciliations,
    exactDetailReconciliations,
    rawLineMatches,
    rawLineMismatches,
    completeHistoryMismatches,
    incompleteHistoryOrders,
    sourceMutations: 0,
    databaseChanges: 0,
  }
  const analysisArtifact = {
    generatedAt: new Date().toISOString(),
    scope: "The 19 K-Electric legacy orders previously classified as ITEM_SUBTOTAL_MISMATCH",
    methodology: "For each order, query the live individual order detail to obtain stable ItemID/current item name/quantity, query Item Price History for the exact LocationID and order date, join by the detail item name, and compare sum(quantity x dated price) with AmountTotal. Export rows are aligned to detail rows only by the preserved line order and identical quantity; no fuzzy name matching is used.",
    importantQualification: "An exact arithmetic match is strong source evidence, but it is not itself authorization to import. Any newly eligible order must pass the full production dry-run and duplicate/idempotency checks.",
    endpoint: ENDPOINT,
    orderDetailEndpoint: `${DETAIL_BASE}/{LocationID}/{OrderID}`,
    rawArtifact: RAW_OUTPUT,
    rawArtifactSha256: rawHash,
    summary,
    orders: orderRows,
    lines: lineRows,
  }
  const analysisText = `${JSON.stringify(analysisArtifact, null, 2)}\n`
  writeFileSync(ANALYSIS_OUTPUT, analysisText, "utf8")

  const overviewRows: Row[] = [
    { Topic: "Finding", Value: `${exactHistoryReconciliations} of 19 orders reconcile exactly using the live price-history API.` },
    { Topic: "Method", Value: "Live order detail supplies stable ItemID/current item name/quantity. That name is joined to exact order date + exact LocationID history; subtotal = sum(quantity x dated price). No fuzzy name match is used." },
    { Topic: "Exact history reconciliations", Value: exactHistoryReconciliations },
    { Topic: "Exact live-detail reconciliations", Value: exactDetailReconciliations },
    { Topic: "Complete history but still mismatched", Value: completeHistoryMismatches },
    { Topic: "Incomplete or ambiguous live history", Value: incompleteHistoryOrders },
    { Topic: "Orders whose raw exported lines match the header", Value: rawLineMatches },
    { Topic: "Orders whose raw exported lines do not match the header", Value: rawLineMismatches },
    { Topic: "Interpretation", Value: "Where live history exactly reconciles a header, the earlier mismatch was caused by stale/current prices being used instead of the branch's dated prices." },
    { Topic: "Import caution", Value: "No order was imported. Reconciled orders are only eligible for a new full dry-run review; they are not automatically production-safe." },
    { Topic: "Source mutation", Value: "None. Only the Item Price History report-query endpoint and individual order-detail GET endpoint were called." },
    { Topic: "Production database changes", Value: "None." },
    { Topic: "Live API endpoint", Value: ENDPOINT },
    { Topic: "Live detail endpoint", Value: `${DETAIL_BASE}/{LocationID}/{OrderID}` },
    { Topic: "Raw API artifact SHA-256", Value: rawHash },
    { Topic: "Earlier workbook", Value: "ke-subtotal-mismatch-19-orders-explained-2026-08-03.xlsx is superseded for price-history conclusions because it used an older retained price-history export." },
  ]
  const apiRows = rawQueries.flatMap((query) => (query.rows as Row[]).map((row) => ({
    "Legacy Order ID": Number(query.legacyOrderId),
    "Requested Location ID": Number(query.locationId),
    "Requested Date": query.orderDate,
    "Date": dateKey(row.Date),
    "Location": String(row.Location ?? ""),
    "Location Group": String(row.LocationGroup ?? ""),
    "Item Name": String(row.ItemName ?? ""),
    "Price PKR": Number(row.Price ?? 0),
  })))
  const detailApiRows = rawQueries.flatMap((query) => (query.orderDetail.OrderDetailsList as Row[]).map((row, index) => ({
    "Legacy Order ID": Number(query.legacyOrderId),
    "Location ID": Number(query.locationId),
    "Order Date": query.orderDate,
    "Line No": index + 1,
    "Order Detail ID": Number(row.ID),
    "Item ID": Number(row.ItemId),
    "Item Name": String(row.Name ?? ""),
    "Quantity": Number(row.Quantity ?? 0),
    "Line Price PKR": Number(row.Price ?? 0),
    "Discount Price PKR": Number(row.DiscountPrice ?? 0),
    "Refund Quantity": Number(row.RefundQuantity ?? 0),
  })))
  const workbook = XLSX.utils.book_new()
  addSheet(workbook, "Conclusion", overviewRows)
  addSheet(workbook, "Order Reconciliation", orderRows, [
    "Header Subtotal PKR", "Live Detail Header PKR", "Live Detail Lines Sum PKR", "Raw Lines Sum PKR", "Raw Difference PKR", "Live History Sum PKR", "History Difference PKR",
  ])
  addSheet(workbook, "Line Price Evidence", lineRows, [
    "Raw Unit Price PKR", "Raw Line Total PKR", "Live Detail Unit Price PKR", "Live Detail Line Total PKR", "Live History Price PKR", "Live History Line Total PKR", "Price Difference PKR",
  ])
  addSheet(workbook, "Raw API History", apiRows, ["Price PKR"])
  addSheet(workbook, "Raw Order Detail", detailApiRows, ["Line Price PKR", "Discount Price PKR"])
  XLSX.writeFile(workbook, EXCEL_OUTPUT, { bookType: "xlsx", compression: true, cellStyles: true })

  const validation = XLSX.readFile(EXCEL_OUTPUT)
  const validationOrders = XLSX.utils.sheet_to_json<Row>(validation.Sheets["Order Reconciliation"], { defval: null })
  const validationLines = XLSX.utils.sheet_to_json<Row>(validation.Sheets["Line Price Evidence"], { defval: null })
  if (validationOrders.length !== 19 || validationLines.length !== sourceLines.length || validation.SheetNames.length !== 5) {
    throw new Error("Excel validation failed")
  }

  console.log(JSON.stringify({
    rawOutput: RAW_OUTPUT,
    rawSha256: rawHash,
    analysisOutput: ANALYSIS_OUTPUT,
    excelOutput: EXCEL_OUTPUT,
    excelSha256: sha256(readFileSync(EXCEL_OUTPUT)),
    sheets: validation.SheetNames,
    summary,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
