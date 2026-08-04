#!/usr/bin/env tsx

import { readFileSync } from "fs"
import { resolve } from "path"
import * as XLSX from "xlsx"

type Row = Record<string, any>

const REPORT_DATE = "2026-08-03"
const REMAINING_REPORT = resolve("updatedReports/ke-remaining-orders-report-2026-07-23.json")
const ORDER_LINES = resolve("updatedReports/orderPurchaseReport.json")
const PRODUCT_SUMMARY = resolve("updatedReports/ke-safe-import-2026-07-23/reports/user-product-summary-report.json")
const PRICE_HISTORY = resolve("updatedReports/ke-safe-import-2026-07-23/reports/item-price-history-report.json")
const OUTPUT = resolve(`updatedReports/ke-subtotal-mismatch-19-orders-explained-${REPORT_DATE}.xlsx`)

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

function normalizeBranch(value: unknown): string {
  const normalized = normalizeText(value)
  return normalized === "1. gso" ? "gso" : normalized
}

function dateKey(value: unknown): string {
  const date = new Date(String(value ?? ""))
  return Number.isNaN(date.getTime()) ? "INVALID_DATE" : date.toISOString().slice(0, 10)
}

function toCents(value: unknown): number {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number)) throw new Error(`Invalid monetary value: ${String(value)}`)
  return Math.round((number + Number.EPSILON) * 100)
}

function addCandidate(map: Map<string, Set<number>>, key: string, cents: number) {
  if (!Number.isSafeInteger(cents) || cents < 0) return
  const values = map.get(key) ?? new Set<number>()
  values.add(cents)
  map.set(key, values)
}

function uniqueCandidate(map: Map<string, Set<number>>, key: string): number | undefined {
  const values = map.get(key)
  return values?.size === 1 ? [...values][0] : undefined
}

function valuesLabel(map: Map<string, Set<number>>, key: string): string {
  const values = [...(map.get(key) ?? [])].sort((a, b) => a - b)
  return values.length === 0 ? "None" : values.map((value) => (value / 100).toFixed(2)).join(" | ")
}

function asMoney(cents: number): number {
  return cents / 100
}

function autoWidth(rows: Row[], headers: string[]): XLSX.ColInfo[] {
  return headers.map((header) => ({
    wch: Math.min(70, Math.max(11, header.length + 2, ...rows.slice(0, 500).map((row) => String(row[header] ?? "").length + 2))),
  }))
}

function addSheet(
  workbook: XLSX.WorkBook,
  name: string,
  rows: Row[],
  headers: string[],
  moneyHeaders: string[] = [],
) {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: headers })
  sheet["!cols"] = autoWidth(rows, headers)
  sheet["!autofilter"] = {
    ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length), c: headers.length - 1 } }),
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

function main() {
  const remaining = readJson<{ categories: Array<{ code: string; legacyOrderIds: number[] }> }>(REMAINING_REPORT)
  const category = remaining.categories.find((item) => item.code === "ITEM_SUBTOTAL_MISMATCH")
  if (!category || category.legacyOrderIds.length !== 19) throw new Error("Expected exactly 19 subtotal-mismatch IDs")
  const mismatchIds = [...category.legacyOrderIds].map(Number).sort((a, b) => a - b)
  const mismatchSet = new Set(mismatchIds)

  const allOrderLines = readJson<Row[]>(ORDER_LINES)
  const sourceLines = allOrderLines.filter((row) => mismatchSet.has(Number(row.ID)))
  const productSummary = readJson<Row[]>(PRODUCT_SUMMARY)
  const priceHistory = readJson<Row[]>(PRICE_HISTORY)

  const linesByOrder = new Map<number, Row[]>()
  for (const line of sourceLines) {
    const id = Number(line.ID)
    linesByOrder.set(id, [...(linesByOrder.get(id) ?? []), line])
  }
  const missingIds = mismatchIds.filter((id) => !linesByOrder.has(id))
  if (missingIds.length > 0) throw new Error(`Missing order lines for IDs: ${missingIds.join(", ")}`)

  const summaryExact = new Map<string, Set<number>>()
  const summaryByDate = new Map<string, Set<number>>()
  const historyExact = new Map<string, Set<number>>()
  const historyByDate = new Map<string, Set<number>>()
  const historyGlobal = new Map<string, Set<number>>()

  for (const row of productSummary) {
    const name = normalizeProductName(row.Name)
    const quantity = Number(row.Item_Qty)
    const revenueCents = toCents(row.SaleRevenue)
    if (!name || !(quantity > 0) || revenueCents < 0) continue
    const effectivePrice = Math.round(revenueCents / quantity)
    const day = dateKey(row.OrderCreatedDT)
    addCandidate(summaryExact, `${normalizeBranch(row.Location)}|${day}|${name}`, effectivePrice)
    addCandidate(summaryByDate, `${day}|${name}`, effectivePrice)
  }

  for (const row of priceHistory) {
    const name = normalizeProductName(row.ItemName)
    const cents = toCents(row.Price)
    const day = dateKey(row.Date)
    addCandidate(historyExact, `${normalizeBranch(row.Location)}|${day}|${name}`, cents)
    addCandidate(historyByDate, `${day}|${name}`, cents)
    addCandidate(historyGlobal, name, cents)
  }

  const orderSummaryRows: Row[] = []
  const lineDetailRows: Row[] = []
  let ordersWhereRawLinesMatchHeader = 0
  let ordersWhereRawLinesAlsoMismatch = 0

  for (const legacyOrderId of mismatchIds) {
    const lines = linesByOrder.get(legacyOrderId)!
    const header = lines[0]
    const headerSubtotalCents = toCents(header.AmountTotal)
    const rawLineSubtotalCents = lines.reduce((sum, line) =>
      sum + Math.round(toCents(line.UnitPrice) * Number(line.ItemQuantity)), 0)

    const evidence = lines.map((line) => {
      const normalizedName = normalizeProductName(line.ItemDetails)
      const day = dateKey(line.OrderCreatedDT)
      const exactKey = `${normalizeBranch(line.Location)}|${day}|${normalizedName}`
      const scopeKeys: Array<[string, Map<string, Set<number>>, string]> = [
        ["Product summary: same branch/day", summaryExact, exactKey],
        ["Price history: same branch/day", historyExact, exactKey],
        ["Product summary: same day", summaryByDate, `${day}|${normalizedName}`],
        ["Price history: same day", historyByDate, `${day}|${normalizedName}`],
        ["Price history: all dates", historyGlobal, normalizedName],
      ]
      const candidates = new Set<number>()
      for (const [, map, key] of scopeKeys) {
        const value = uniqueCandidate(map, key)
        if (value !== undefined) candidates.add(value)
      }
      return { line, normalizedName, day, exactKey, scopeKeys, candidates, priceCents: candidates.size === 1 ? [...candidates][0] : undefined as number | undefined }
    })

    const missing = evidence.flatMap((item, index) => item.priceCents === undefined ? [index] : [])
    let orderPricingMethod = "CONSENSUS_EVIDENCE"
    if (missing.length === 1) {
      const knownTotal = evidence.reduce((sum, item) => sum + (item.priceCents === undefined
        ? 0
        : Math.round(item.priceCents * Number(item.line.ItemQuantity))), 0)
      const index = missing[0]
      const quantity = Number(evidence[index].line.ItemQuantity)
      const residual = headerSubtotalCents - knownTotal
      if (quantity > 0 && residual >= 0 && residual % quantity === 0) {
        evidence[index].priceCents = residual / quantity
        orderPricingMethod = "SINGLE_RESIDUAL_FOR_ONE_MISSING_PRICE"
      }
    } else if (missing.length > 1) {
      for (const index of missing) evidence[index].priceCents = toCents(evidence[index].line.UnitPrice)
      orderPricingMethod = "RAW_PRICE_FALLBACK_FOR_MULTIPLE_MISSING_PRICES"
    }

    if (evidence.some((item) => item.priceCents === undefined)) {
      throw new Error(`Order ${legacyOrderId} unexpectedly still has an unresolved price`)
    }
    const resolvedSubtotalCents = evidence.reduce((sum, item) =>
      sum + Math.round(item.priceCents! * Number(item.line.ItemQuantity)), 0)
    if (resolvedSubtotalCents === headerSubtotalCents) {
      throw new Error(`Order ${legacyOrderId} unexpectedly reconciles; source evidence changed`)
    }

    const rawMatches = rawLineSubtotalCents === headerSubtotalCents
    if (rawMatches) ordersWhereRawLinesMatchHeader += 1
    else ordersWhereRawLinesAlsoMismatch += 1
    const changedPriceLines = evidence.filter((item) => item.priceCents !== toCents(item.line.UnitPrice)).length
    const resolvedDifferenceCents = resolvedSubtotalCents - headerSubtotalCents
    const rawDifferenceCents = rawLineSubtotalCents - headerSubtotalCents
    const mainReason = rawMatches
      ? "The order export's own lines match the header, but one or more unit prices conflict with independent product-summary/price-history evidence. The importer will not choose one source by guesswork."
      : resolvedSubtotalCents === rawLineSubtotalCents
        ? "The exported item quantities × unit prices do not add up to the order header subtotal."
        : "The raw item arithmetic and the independently reconstructed price evidence both conflict with the order header subtotal."

    orderSummaryRows.push({
      "Legacy Order ID": legacyOrderId,
      "Branch": String(header.Location ?? ""),
      "Registration No": String(header.RegistrationNo ?? ""),
      "User": String(header.UserDetails ?? header.LastUpdateBy ?? ""),
      "Order Date": dateKey(header.OrderCreatedDT),
      "Status ID": Number(header.StatusID),
      "Delivery Status": Number(header.DeliveryStatus),
      "Item Lines": lines.length,
      "Changed Price Lines": changedPriceLines,
      "Header Subtotal PKR": asMoney(headerSubtotalCents),
      "Raw Lines Sum PKR": asMoney(rawLineSubtotalCents),
      "Raw Difference PKR": asMoney(rawDifferenceCents),
      "Importer Resolved Sum PKR": asMoney(resolvedSubtotalCents),
      "Resolved Difference PKR": asMoney(resolvedDifferenceCents),
      "Tax PKR": Number(header.Tax ?? 0),
      "Grand Total PKR": Number(header.GrandTotal ?? 0),
      "Pricing Method": orderPricingMethod,
      "Mismatch Direction": resolvedDifferenceCents > 0 ? "Resolved item sum is ABOVE header" : "Resolved item sum is BELOW header",
      "Why It Is Blocked": mainReason,
      "Import Decision": "DO NOT IMPORT AS A NORMAL ORDER",
      "Evidence Needed": "Corrected authoritative item quantities and unit prices that add exactly to the header subtotal, with conflicting price sources resolved.",
    })

    evidence.forEach((item, index) => {
      const rawPriceCents = toCents(item.line.UnitPrice)
      const resolvedPriceCents = item.priceCents!
      const quantity = Number(item.line.ItemQuantity)
      const rawTotalCents = Math.round(rawPriceCents * quantity)
      const resolvedTotalCents = Math.round(resolvedPriceCents * quantity)
      const priceChanged = rawPriceCents !== resolvedPriceCents
      lineDetailRows.push({
        "Legacy Order ID": legacyOrderId,
        "Line No": index + 1,
        "Branch": String(item.line.Location ?? ""),
        "Order Date": item.day,
        "Item": String(item.line.ItemDetails ?? ""),
        "Quantity": quantity,
        "Raw Unit Price PKR": asMoney(rawPriceCents),
        "Raw Line Total PKR": asMoney(rawTotalCents),
        "Resolved Unit Price PKR": asMoney(resolvedPriceCents),
        "Resolved Line Total PKR": asMoney(resolvedTotalCents),
        "Line Difference vs Raw PKR": asMoney(resolvedTotalCents - rawTotalCents),
        "Price Changed": priceChanged ? "YES - REVIEW" : "No",
        "Resolution Method": item.candidates.size === 1
          ? "One consensus value across usable evidence"
          : orderPricingMethod === "SINGLE_RESIDUAL_FOR_ONE_MISSING_PRICE" && missing.includes(index)
            ? "Calculated as the sole residual needed for the header"
            : missing.includes(index)
              ? "Raw UnitPrice fallback because multiple items lacked one consensus value"
              : "Consensus evidence",
        "Usable Consensus Values PKR": [...item.candidates].sort((a, b) => a - b).map((value) => asMoney(value)).join(" | ") || "None",
        "Product Summary Same Branch/Day PKR": valuesLabel(summaryExact, item.exactKey),
        "Price History Same Branch/Day PKR": valuesLabel(historyExact, item.exactKey),
        "Product Summary Same Day PKR": valuesLabel(summaryByDate, `${item.day}|${item.normalizedName}`),
        "Price History Same Day PKR": valuesLabel(historyByDate, `${item.day}|${item.normalizedName}`),
        "Price History All Dates PKR": valuesLabel(historyGlobal, item.normalizedName),
        "Line Explanation": priceChanged
          ? "The price printed on this order line differs from the only consensus price supported by the usable cross-report evidence."
          : "This line's raw price was retained; the order still fails when all resolved line totals are added together.",
      })
    })
  }

  const explanationRows: Row[] = [
    { "Topic": "Report", "Explanation": "K-Electric — 19 legacy orders blocked by item subtotal mismatch" },
    { "Topic": "Meaning", "Explanation": "For every order, the header contains an authoritative subtotal. The importer reconstructs the item subtotal as Σ(quantity × defensible unit price). These 19 reconstructed totals are not equal to their headers." },
    { "Topic": "Why this matters", "Explanation": "Saving a mismatched order would make its order total disagree with its item details, affecting sales, product, user, branch, receipt, and refund reporting." },
    { "Topic": "Raw Lines Sum", "Explanation": "Σ(quantity × UnitPrice) using the prices printed directly in orderPurchaseReport.json." },
    { "Topic": "Importer Resolved Sum", "Explanation": "Σ(quantity × resolved price) using the same conservative evidence rule as the production importer: applicable product-summary and price-history evidence must collapse to one value; otherwise the importer uses only its documented fallback rules." },
    { "Topic": "Difference sign", "Explanation": "Difference = calculated item sum − header subtotal. Positive means the item sum is too high; negative means it is too low." },
    { "Topic": "Orders where raw lines match header", "Explanation": ordersWhereRawLinesMatchHeader },
    { "Topic": "Orders where raw lines also mismatch", "Explanation": ordersWhereRawLinesAlsoMismatch },
    { "Topic": "Current decision", "Explanation": "Do not import these as normal fulfilled orders. No database changes were made while producing this report." },
    { "Topic": "Evidence required", "Explanation": "A corrected authoritative line export showing the final quantity and unit price for every item, with a line sum that exactly equals the header subtotal and resolves any cross-report price conflict." },
    { "Topic": "Legacy order IDs", "Explanation": mismatchIds.join(", ") },
    { "Topic": "Source: classification", "Explanation": "updatedReports/ke-remaining-orders-report-2026-07-23.json" },
    { "Topic": "Source: order lines", "Explanation": "updatedReports/orderPurchaseReport.json" },
    { "Topic": "Source: product evidence", "Explanation": "updatedReports/ke-safe-import-2026-07-23/reports/user-product-summary-report.json" },
    { "Topic": "Source: price evidence", "Explanation": "updatedReports/ke-safe-import-2026-07-23/reports/item-price-history-report.json" },
  ]

  const orderHeaders = Object.keys(orderSummaryRows[0])
  const lineHeaders = Object.keys(lineDetailRows[0])
  const workbook = XLSX.utils.book_new()
  addSheet(workbook, "Explanation", explanationRows, ["Topic", "Explanation"])
  addSheet(workbook, "Order Summary", orderSummaryRows, orderHeaders, [
    "Header Subtotal PKR", "Raw Lines Sum PKR", "Raw Difference PKR",
    "Importer Resolved Sum PKR", "Resolved Difference PKR", "Tax PKR", "Grand Total PKR",
  ])
  addSheet(workbook, "Line Evidence", lineDetailRows, lineHeaders, [
    "Raw Unit Price PKR", "Raw Line Total PKR", "Resolved Unit Price PKR",
    "Resolved Line Total PKR", "Line Difference vs Raw PKR",
  ])
  XLSX.writeFile(workbook, OUTPUT, { bookType: "xlsx", compression: true, cellStyles: true })

  const validation = XLSX.readFile(OUTPUT, { cellDates: false })
  const summaryRows = XLSX.utils.sheet_to_json<Row>(validation.Sheets["Order Summary"], { defval: null, raw: true })
  const detailRows = XLSX.utils.sheet_to_json<Row>(validation.Sheets["Line Evidence"], { defval: null, raw: true })
  const ids = [...new Set(summaryRows.map((row) => Number(row["Legacy Order ID"])))].sort((a, b) => a - b)
  if (!validation.SheetNames.includes("Explanation")
    || summaryRows.length !== 19
    || detailRows.length !== sourceLines.length
    || JSON.stringify(ids) !== JSON.stringify(mismatchIds)) {
    throw new Error("Generated workbook validation failed")
  }

  console.log(JSON.stringify({
    output: OUTPUT,
    sheets: validation.SheetNames,
    orders: summaryRows.length,
    lineRows: detailRows.length,
    ordersWhereRawLinesMatchHeader,
    ordersWhereRawLinesAlsoMismatch,
    legacyOrderIds: ids,
  }, null, 2))
}

main()
