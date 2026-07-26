import { readFileSync } from "fs"
import { basename, relative, resolve } from "path"
import * as XLSX from "xlsx"

type JsonRow = Record<string, unknown>

interface ReportCategory {
  code: string
  title: string
  reason: string
  requiredEvidence: string
  count: number
  legacyOrderIds: number[]
  details?: Record<string, unknown>
}

interface RemainingReport {
  generatedAt: string
  reportDate: string
  organization: {
    id: number
    code: string
    name: string
  }
  counts: {
    knownLegacyOrderIds: number
    importedLegacyOrderIds: number
    importedBeforeIncrementalBatch: number
    importedInIncrementalBatch: number
    remainingNotSafeToImport: number
  }
  categories: ReportCategory[]
}

interface IndexedRow {
  rowNumber: number
  row: JsonRow
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

function readExcelRows(path: string): JsonRow[] {
  const workbook = XLSX.readFile(path, { cellDates: false })
  const sheetName = workbook.SheetNames[0]
  return XLSX.utils.sheet_to_json<JsonRow>(workbook.Sheets[sheetName], {
    defval: null,
    raw: true,
  })
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

function normalizeUser(value: unknown): string {
  return normalizeText(value).replace(/\s+-\s*$/, "").trim()
}

function normalizeBranch(value: unknown): string {
  const normalized = normalizeText(value)
  return normalized === "1. gso" ? "gso" : normalized
}

function normalizeItem(value: unknown): string {
  return normalizeText(value)
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s*\)\s*/g, ")")
    .replace(/\s*-\s*/g, "-")
}

function normalizeRegistration(value: unknown): string {
  return String(value ?? "").replace(/\.0$/, "").trim()
}

function dateKey(value: unknown): string {
  const date = new Date(String(value ?? ""))
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10)
}

function asDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))].sort()
}

function indexRowsById(rows: JsonRow[]): Map<number, IndexedRow[]> {
  const result = new Map<number, IndexedRow[]>()
  rows.forEach((row, index) => {
    const id = Number(row.ID)
    if (!Number.isSafeInteger(id)) return
    const existing = result.get(id) ?? []
    existing.push({ rowNumber: index + 2, row })
    result.set(id, existing)
  })
  return result
}

function excelRowRanges(rowNumbers: number[]): string {
  const rows = [...new Set(rowNumbers)].sort((a, b) => a - b)
  if (rows.length === 0) return ""

  const ranges: string[] = []
  let start = rows[0]
  let previous = rows[0]
  for (const row of rows.slice(1)) {
    if (row === previous + 1) {
      previous = row
      continue
    }
    ranges.push(start === previous ? String(start) : `${start}-${previous}`)
    start = row
    previous = row
  }
  ranges.push(start === previous ? String(start) : `${start}-${previous}`)
  return ranges.join(", ")
}

function statusLabel(statusId: unknown, deliveryStatus: unknown, hasRefund: boolean): string {
  if (hasRefund) return "Refund evidence"
  const status = Number(statusId)
  const delivery = Number(deliveryStatus)
  if (status === 5 || (status === 4 && delivery === 508)) return "Cancelled"
  if ((status === 1 || status === 2) && delivery === 501) return "Order Placed"
  if (status === 2 && delivery === 503) return "In Process"
  if (status === 2 && delivery === 505) return "Partial Delivery"
  if (status === 2 && delivery === 506) return "Out For Delivery"
  if (status === 2 && delivery === 507) return "Delivered"
  return `Unknown (${status}/${delivery})`
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sameText(left: unknown, right: unknown): boolean {
  return normalizeText(left) === normalizeText(right)
}

function validateAlignedOrderRows(jsonRows: JsonRow[], excelRows: JsonRow[], label: string) {
  assert(jsonRows.length === excelRows.length, `${label}: JSON/Excel row counts differ`)
  jsonRows.forEach((row, index) => {
    const excel = excelRows[index]
    assert(
      Number(row.TransactionNo) === Number(excel.TransactionNo)
      && Number(row.OrderNo) === Number(excel.OrderNo)
      && sameText(row.LocationName, excel.Location),
      `${label}: JSON/Excel order alignment failed at Excel row ${index + 2}`,
    )
  })
}

function validateAlignedSalesRows(jsonRows: JsonRow[], excelRows: JsonRow[], label: string) {
  assert(jsonRows.length === excelRows.length, `${label}: JSON/Excel row counts differ`)
  jsonRows.forEach((row, index) => {
    const excel = excelRows[index]
    assert(
      Number(row.TransactionNo) === Number(excel.TransactionNo)
      && Number(row.OrderNo) === Number(excel.OrderNo)
      && sameText(row.Location, excel.Branch)
      && sameText(row.ItemDetails, excel.ItemDetails)
      && Number(row.ItemQuantity) === Number(excel.ItemQuantity),
      `${label}: JSON/Excel sales alignment failed at Excel row ${index + 2}`,
    )
  })
}

function validateAlignedRefundRows(jsonRows: JsonRow[], excelRows: JsonRow[]) {
  assert(jsonRows.length === excelRows.length, "Refund report JSON/Excel row counts differ")
  jsonRows.forEach((row, index) => {
    const excel = excelRows[index]
    assert(
      Number(row.TransactionNo) === Number(excel.TransactionNo)
      && Number(row.OrderNo) === Number(excel.OrderNo)
      && sameText(row.Location, excel.Branch)
      && Number(row.RefundAmount) === Number(excel.RefundAmount),
      `Refund report JSON/Excel alignment failed at Excel row ${index + 2}`,
    )
  })
}

function validateAlignedGroupRows(jsonRows: JsonRow[], excelRows: JsonRow[]) {
  assert(jsonRows.length === excelRows.length, "GroupWise JSON/Excel row counts differ")
  jsonRows.forEach((row, index) => {
    const excel = excelRows[index]
    assert(
      normalizeRegistration(row.Emp__) === normalizeRegistration(excel["Emp #"])
      && sameText(row.Item_Details, excel["Item Details"])
      && Number(row.Quantity_Ordered) === Number(excel["QTY Ordered"])
      && Number(row.Qty_Delivered) === Number(excel["QTY Delivered"]),
      `GroupWise JSON/Excel alignment failed at Excel row ${index + 2}`,
    )
  })
}

function addToIndex(index: Map<string, IndexedRow[]>, key: string, entry: IndexedRow) {
  if (!key) return
  const values = index.get(key) ?? []
  values.push(entry)
  index.set(key, values)
}

function crossReportKey(row: {
  date: unknown
  registration: unknown
  user: unknown
  group: unknown
  item: unknown
}): string {
  const day = dateKey(row.date)
  const registration = normalizeRegistration(row.registration)
  const item = normalizeItem(row.item)
  if (!day || !item) return ""
  if (registration) return `${day}|reg:${registration}|${item}`
  return `${day}|user:${normalizeUser(row.user)}|group:${normalizeText(row.group)}|${item}`
}

function findCrossReportRows(
  index: Map<string, IndexedRow[]>,
  row: {
    date: unknown
    registration: unknown
    user: unknown
    group: unknown
    item: unknown
    location?: unknown
  },
): IndexedRow[] {
  const candidates = index.get(crossReportKey(row)) ?? []
  if (candidates.length <= 1) return candidates

  const user = normalizeUser(row.user)
  const group = normalizeText(row.group)
  const location = normalizeBranch(row.location)
  const refined = candidates.filter((candidate) => {
    const candidateUser = normalizeUser(candidate.row.User_Details ?? candidate.row.UserName)
    const candidateGroup = normalizeText(candidate.row.Group)
    const candidateLocation = normalizeBranch(candidate.row.Location)
    return (!user || !candidateUser || user === candidateUser)
      && (!group || !candidateGroup || group === candidateGroup)
      && (!location || !candidateLocation || location === candidateLocation)
  })
  return refined.length > 0 ? refined : candidates
}

function buildIndex(
  rows: JsonRow[],
  fields: {
    date: string
    registration: string
    user: string
    group: string
    item: string
  },
  rowOffset: number,
): Map<string, IndexedRow[]> {
  const index = new Map<string, IndexedRow[]>()
  rows.forEach((row, rowIndex) => {
    addToIndex(index, crossReportKey({
      date: row[fields.date],
      registration: row[fields.registration],
      user: row[fields.user],
      group: row[fields.group],
      item: row[fields.item],
    }), {
      rowNumber: rowIndex + rowOffset,
      row,
    })
  })
  return index
}

function orderIdentity(line: JsonRow): string {
  return [
    Number(line.ID),
    normalizeItem(line.ItemDetails),
    Number(line.ItemQuantity),
  ].join("|")
}

function formatMoneyList(rows: IndexedRow[], field: string): string {
  return uniqueStrings(rows.map(({ row }) => {
    const value = asNumber(row[field])
    return value === null ? "" : value.toFixed(2)
  })).join(", ")
}

function autoWidth(rows: JsonRow[], headers: string[]): XLSX.ColInfo[] {
  return headers.map((header) => {
    const maximum = rows.reduce((width, row) => {
      const value = row[header]
      const text = value instanceof Date
        ? value.toISOString()
        : String(value ?? "")
      return Math.max(width, text.length)
    }, header.length)
    return { wch: Math.min(Math.max(maximum + 2, 11), 52) }
  })
}

function addSheet(
  workbook: XLSX.WorkBook,
  name: string,
  rows: JsonRow[],
  options: {
    headers?: string[]
    dateHeaders?: string[]
    moneyHeaders?: string[]
    integerHeaders?: string[]
  } = {},
) {
  const headers = options.headers ?? (rows[0] ? Object.keys(rows[0]) : [])
  const sheet = XLSX.utils.json_to_sheet(rows, { header: headers })
  sheet["!cols"] = autoWidth(rows, headers)
  sheet["!autofilter"] = {
    ref: XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: Math.max(rows.length, 1), c: Math.max(headers.length - 1, 0) },
    }),
  }
  sheet["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft" }

  const headerIndex = new Map(headers.map((header, index) => [header, index]))
  const applyFormat = (selectedHeaders: string[], format: string) => {
    for (const header of selectedHeaders) {
      const column = headerIndex.get(header)
      if (column === undefined) continue
      for (let row = 1; row <= rows.length; row += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })]
        if (cell) cell.z = format
      }
    }
  }
  applyFormat(options.dateHeaders ?? [], "yyyy-mm-dd hh:mm")
  applyFormat(options.moneyHeaders ?? [], "#,##0.00")
  applyFormat(options.integerHeaders ?? [], "0")

  XLSX.utils.book_append_sheet(workbook, sheet, name)
}

async function main() {
  const repoRoot = process.cwd()
  const updatedRoot = resolve(repoRoot, "reports/updatedReports")
  const investigationRoot = resolve(repoRoot, "tmp/ke-updated-investigation/reports")
  const reportPath = resolve(updatedRoot, "ke-remaining-orders-report-2026-07-23.json")
  const outputPath = resolve(
    updatedRoot,
    "ke-unimported-orders-details-excluding-cancelled-refunded-2026-07-23.xlsx",
  )

  const paths = {
    updatedOrdersExcel: resolve(updatedRoot, "Orders (8).xls"),
    updatedSalesExcel: resolve(updatedRoot, "Sales Report (8).xls"),
    refundExcel: resolve(updatedRoot, "RefundReport.xls"),
    groupWiseExcel: resolve(updatedRoot, "GroupWiseReport.xlsx.xls"),
    budgetExcel: resolve(updatedRoot, "BudgetReport_.xlsx (1).xls"),
    priorOrdersExcel: resolve(repoRoot, "reports/Orders.xls"),
    priorSalesExcel: resolve(repoRoot, "reports/Sales Report (5).xls"),
    productSummaryJson: resolve(updatedRoot, "productSummery.json"),
    userProductSummaryJson: resolve(updatedRoot, "UserProductSummary.json"),
  }

  const remainingReport = readJson<RemainingReport>(reportPath)
  const updatedHeaders = readJson<JsonRow[]>(resolve(investigationRoot, "order.json"))
  const updatedSales = readJson<JsonRow[]>(resolve(updatedRoot, "orderPurchaseReport.json"))
  const refundRows = readJson<JsonRow[]>(resolve(updatedRoot, "refundReport.json"))
  const groupWiseRows = readJson<JsonRow[]>(resolve(updatedRoot, "groupWiseReport.json"))
  const budgetRows = readJson<JsonRow[]>(resolve(updatedRoot, "budgetReport.json"))
  const productSummaryRows = readJson<JsonRow[]>(paths.productSummaryJson)
  const userProductSummaryRows = readJson<JsonRow[]>(paths.userProductSummaryJson)
  const priorHeaders = readJson<JsonRow[]>(resolve(repoRoot, "reports/order.json"))
  const priorSales = readJson<JsonRow[]>(resolve(repoRoot, "reports/sales-report.json"))

  const rawUpdatedOrders = readExcelRows(paths.updatedOrdersExcel)
  const rawUpdatedSales = readExcelRows(paths.updatedSalesExcel)
  const rawRefunds = readExcelRows(paths.refundExcel)
  const rawGroupWise = readExcelRows(paths.groupWiseExcel)
  const rawBudget = readExcelRows(paths.budgetExcel)
  const rawPriorOrders = readExcelRows(paths.priorOrdersExcel)
  const rawPriorSales = readExcelRows(paths.priorSalesExcel)

  validateAlignedOrderRows(updatedHeaders, rawUpdatedOrders, basename(paths.updatedOrdersExcel))
  validateAlignedSalesRows(updatedSales, rawUpdatedSales, basename(paths.updatedSalesExcel))
  validateAlignedRefundRows(refundRows, rawRefunds)
  validateAlignedGroupRows(groupWiseRows, rawGroupWise)
  validateAlignedOrderRows(priorHeaders, rawPriorOrders, basename(paths.priorOrdersExcel))
  validateAlignedSalesRows(priorSales, rawPriorSales, basename(paths.priorSalesExcel))
  assert(budgetRows.length === rawBudget.length, "Budget JSON/Excel row counts differ")

  const categoryById = new Map<number, ReportCategory>()
  for (const category of remainingReport.categories) {
    for (const id of category.legacyOrderIds) {
      assert(!categoryById.has(id), `Legacy order ${id} appears in multiple blocker categories`)
      categoryById.set(id, category)
    }
  }
  assert(
    categoryById.size === remainingReport.counts.remainingNotSafeToImport,
    "Remaining report category coverage is incomplete",
  )
  const allRemainingIds = [...categoryById.keys()].sort((a, b) => a - b)

  const updatedHeaderById = new Map(
    updatedHeaders.map((row, index) => [Number(row.ID), { rowNumber: index + 2, row }]),
  )
  const priorHeaderById = new Map(
    priorHeaders.map((row, index) => [Number(row.ID), { rowNumber: index + 2, row }]),
  )
  const updatedSalesById = indexRowsById(updatedSales)
  const priorSalesById = indexRowsById(priorSales)
  const refundById = new Map(
    refundRows.map((row, index) => [Number(row.ID), { rowNumber: index + 2, row }]),
  )
  const refundedIds = allRemainingIds.filter(
    (id) => categoryById.get(id)?.code === "HAS_REFUND_EVIDENCE",
  )
  const refundedSet = new Set(refundedIds)
  const cancelledIds = allRemainingIds.filter((id) => {
    if (refundedSet.has(id)) return false
    const header = updatedHeaderById.get(id)?.row ?? priorHeaderById.get(id)?.row
    if (!header) return false
    const statusId = Number(header.StatusID)
    const deliveryStatus = Number(header.DeliveryStatus)
    const rawStatus = updatedHeaderById.has(id)
      ? rawUpdatedOrders[(updatedHeaderById.get(id) as IndexedRow).rowNumber - 2]?.["Order Status"]
      : rawPriorOrders[(priorHeaderById.get(id) as IndexedRow).rowNumber - 2]?.["Order Status"]
    return statusId === 5
      || (statusId === 4 && deliveryStatus === 508)
      || ["cancelled", "canceled"].includes(normalizeText(rawStatus))
  })
  const excludedIds = new Set([...refundedIds, ...cancelledIds])
  const remainingIds = allRemainingIds.filter((id) => !excludedIds.has(id))
  const remainingSet = new Set(remainingIds)

  assert(refundedIds.length === 25, `Expected 25 refunded orders, found ${refundedIds.length}`)
  assert(cancelledIds.length === 88, `Expected 88 cancelled orders, found ${cancelledIds.length}`)
  assert(remainingIds.length === 53, `Expected 53 filtered orders, found ${remainingIds.length}`)

  const groupWiseIndex = buildIndex(groupWiseRows, {
    date: "OrderDate",
    registration: "Emp__",
    user: "User_Details",
    group: "Group",
    item: "Item_Details",
  }, 2)
  const productSummaryIndex = buildIndex(productSummaryRows, {
    date: "OrderCreatedDT",
    registration: "RegistrationNo",
    user: "UserName",
    group: "Group",
    item: "Name",
  }, 1)
  const userProductSummaryIndex = buildIndex(userProductSummaryRows, {
    date: "OrderCreatedDT",
    registration: "RegistrationNo",
    user: "UserName",
    group: "Group",
    item: "Name",
  }, 1)

  const priorSalesIdentityIndex = new Map<string, IndexedRow[]>()
  priorSales.forEach((row, index) => {
    addToIndex(priorSalesIdentityIndex, orderIdentity(row), { rowNumber: index + 2, row })
  })

  const orderItems: JsonRow[] = []
  for (const id of remainingIds) {
    const category = categoryById.get(id) as ReportCategory
    const currentLines = updatedSalesById.get(id) ?? []
    const oldLines = priorSalesById.get(id) ?? []
    const selectedLines = currentLines.length > 0 ? currentLines : oldLines
    const lineSource = currentLines.length > 0
      ? basename(paths.updatedSalesExcel)
      : oldLines.length > 0
        ? basename(paths.priorSalesExcel)
        : "No item lines"

    for (const selected of selectedLines) {
      const line = selected.row
      const matchInput = {
        date: line.OrderCreatedDT,
        registration: line.RegistrationNo,
        user: line.UserDetails,
        group: line.LocationGroup,
        item: line.ItemDetails,
        location: line.Location,
      }
      const groupMatches = findCrossReportRows(groupWiseIndex, matchInput)
      const productMatches = findCrossReportRows(productSummaryIndex, matchInput)
      const userProductMatches = findCrossReportRows(userProductSummaryIndex, matchInput)
      const priorMatches = priorSalesIdentityIndex.get(orderIdentity(line)) ?? []
      const quantity = asNumber(line.ItemQuantity)
      const unitPrice = asNumber(line.UnitPrice)

      orderItems.push({
        "Legacy Order ID": id,
        "Blocker": category.title,
        "Line Source": lineSource,
        "Order Date": asDate(line.OrderCreatedDT),
        "Branch": line.Location ?? "",
        "Registration No": normalizeRegistration(line.RegistrationNo),
        "Location Group": line.LocationGroup ?? "",
        "User Details": line.UserDetails ?? "",
        "Order No": asNumber(line.OrderNo),
        "Transaction No": asNumber(line.TransactionNo),
        "Item": line.ItemDetails ?? "",
        "Quantity": quantity,
        "Raw Unit Price (JSON)": unitPrice,
        "Raw Extended Value": quantity !== null && unitPrice !== null ? quantity * unitPrice : null,
        "Reported Order Subtotal": asNumber(line.AmountTotal),
        "Reported Order Tax": asNumber(line.Tax),
        "Reported Order Grand Total": asNumber(line.GrandTotal),
        "Updated Sales XLS Row": currentLines.includes(selected) ? selected.rowNumber : "",
        "Prior Sales XLS Candidate Rows": excelRowRanges(priorMatches.map((match) => match.rowNumber)),
        "GroupWise XLS Candidate Rows": excelRowRanges(groupMatches.map((match) => match.rowNumber)),
        "GroupWise Item Code": uniqueStrings(groupMatches.map(({ row }) => row.Item_Code)).join(", "),
        "GroupWise Unit Rate": formatMoneyList(groupMatches, "Unit_Rate"),
        "GroupWise Qty Ordered": uniqueStrings(groupMatches.map(({ row }) => row.Quantity_Ordered)).join(", "),
        "GroupWise Qty Delivered": uniqueStrings(groupMatches.map(({ row }) => row.Qty_Delivered)).join(", "),
        "GroupWise Delivered Value": formatMoneyList(groupMatches, "Value_of_Qty_Delivered"),
        "Product Summary JSON Rows": excelRowRanges(productMatches.map((match) => match.rowNumber)),
        "Product Summary Status": uniqueStrings(productMatches.map(({ row }) => row.OrderStatus)).join(", "),
        "Product Summary Unit Price": formatMoneyList(productMatches, "UnitPrice"),
        "Product Summary Quantity": uniqueStrings(productMatches.map(({ row }) => row.Item_Qty)).join(", "),
        "User Product Summary JSON Rows": excelRowRanges(userProductMatches.map((match) => match.rowNumber)),
        "User Product Summary Status": uniqueStrings(userProductMatches.map(({ row }) => row.OrderStatus)).join(", "),
        "Cross-report Match Basis": normalizeRegistration(line.RegistrationNo)
          ? "Date + Registration No + Item; user/group/location used to refine duplicates"
          : "Date + User + Group + Item; location used to refine duplicates",
      })
    }
  }

  const itemRowsById = new Map<number, JsonRow[]>()
  for (const item of orderItems) {
    const id = Number(item["Legacy Order ID"])
    const rows = itemRowsById.get(id) ?? []
    rows.push(item)
    itemRowsById.set(id, rows)
  }

  const orderRows: JsonRow[] = remainingIds.map((id) => {
    const category = categoryById.get(id) as ReportCategory
    const currentHeader = updatedHeaderById.get(id)
    const oldHeader = priorHeaderById.get(id)
    const currentLines = updatedSalesById.get(id) ?? []
    const oldLines = priorSalesById.get(id) ?? []
    const refund = refundById.get(id)
    const selectedHeader = currentHeader?.row ?? oldHeader?.row
    const selectedLines = currentLines.length > 0 ? currentLines : oldLines
    const firstLine = selectedLines[0]?.row
    const identitySource = selectedHeader ?? firstLine ?? {}
    const relatedItems = itemRowsById.get(id) ?? []
    const rawItemSubtotal = selectedLines.reduce((sum, { row }) => {
      const quantity = asNumber(row.ItemQuantity) ?? 0
      const unitPrice = asNumber(row.UnitPrice) ?? 0
      return sum + quantity * unitPrice
    }, 0)
    const reportedSubtotal = asNumber(firstLine?.AmountTotal)
    const registrations = uniqueStrings(selectedLines.map(({ row }) => normalizeRegistration(row.RegistrationNo)))
    const itemNames = uniqueStrings(selectedLines.map(({ row }) => row.ItemDetails))
    const quantity = selectedLines.reduce((sum, { row }) => sum + (asNumber(row.ItemQuantity) ?? 0), 0)
    const budgetDate = asDate(identitySource.CreatedOn ?? identitySource.OrderCreatedDT)
    const branch = identitySource.LocationName ?? identitySource.Location ?? firstLine?.Location ?? ""
    const budgetMatches = budgetRows.flatMap((row, index) => {
      const from = asDate(row.TenureFrom)
      const to = asDate(row.TenureTo)
      if (
        !budgetDate
        || !from
        || !to
        || normalizeBranch(row.Location) !== normalizeBranch(branch)
        || budgetDate < from
        || budgetDate > new Date(to.getTime() + 86_399_999)
      ) return []
      return [{ rowNumber: index + 2, row }]
    })
    const statusId = identitySource.StatusID
    const deliveryStatus = identitySource.DeliveryStatus
    const updatedStatus = currentHeader
      ? rawUpdatedOrders[currentHeader.rowNumber - 2]?.["Order Status"]
      : ""
    const priorStatus = oldHeader
      ? rawPriorOrders[oldHeader.rowNumber - 2]?.["Order Status"]
      : ""

    let primaryLookup = ""
    if (refund) {
      primaryLookup = `${basename(paths.refundExcel)} row ${refund.rowNumber}`
    } else if (currentHeader) {
      primaryLookup = `${basename(paths.updatedOrdersExcel)} row ${currentHeader.rowNumber}`
    } else if (currentLines.length > 0) {
      primaryLookup = `${basename(paths.updatedSalesExcel)} rows ${excelRowRanges(currentLines.map((line) => line.rowNumber))}`
    } else if (oldHeader) {
      primaryLookup = `${basename(paths.priorOrdersExcel)} row ${oldHeader.rowNumber}`
    }

    return {
      "Legacy Order ID": id,
      "Blocker Code": category.code,
      "Blocker": category.title,
      "Reason": category.reason,
      "Evidence / Correction Needed": category.requiredEvidence,
      "Current Interpretation": statusLabel(statusId, deliveryStatus, Boolean(refund)),
      "Updated Order Status": updatedStatus ?? "",
      "Prior Order Status": priorStatus ?? "",
      "StatusID": asNumber(statusId),
      "DeliveryStatus": asNumber(deliveryStatus),
      "Order Date": asDate(identitySource.OrderCreatedDT),
      "Created On": asDate(identitySource.CreatedOn),
      "Last Updated": asDate(identitySource.LastUpdateDT),
      "Branch / Location": branch,
      "Location Group": identitySource.LocationGroup ?? firstLine?.LocationGroup ?? "",
      "User Details": identitySource.UserDetails ?? firstLine?.UserDetails ?? "",
      "Registration No(s)": registrations.join(", "),
      "Order No": asNumber(identitySource.OrderNo),
      "Transaction No": asNumber(identitySource.TransactionNo),
      "Order Type": identitySource.OrderType ?? "",
      "Payment Mode Code": asNumber(firstLine?.PaymentMode),
      "Reported Subtotal": reportedSubtotal,
      "Raw Unit Price × Qty": selectedLines.length > 0 ? rawItemSubtotal : null,
      "Raw vs Reported Difference": reportedSubtotal === null || selectedLines.length === 0
        ? null
        : rawItemSubtotal - reportedSubtotal,
      "Discount": asNumber(firstLine?.AmountDiscount),
      "Service Charges": asNumber(firstLine?.ServiceCharges),
      "Tax": asNumber(firstLine?.Tax),
      "Grand Total": asNumber(identitySource.GrandTotal ?? firstLine?.GrandTotal),
      "Refund Amount": asNumber(refund?.row.RefundAmount),
      "Refund Tax": asNumber(refund?.row.TaxRefund),
      "Selected Item Lines": relatedItems.length,
      "Total Reported Quantity": selectedLines.length > 0 ? quantity : null,
      "Item Names": itemNames.join(" | "),
      "Primary Excel Lookup": primaryLookup,
      "Updated Orders XLS Row": currentHeader?.rowNumber ?? "",
      "Updated Sales XLS Rows": excelRowRanges(currentLines.map((line) => line.rowNumber)),
      "Updated Sales Line Count": currentLines.length,
      "Refund XLS Row": refund?.rowNumber ?? "",
      "Prior Orders XLS Row": oldHeader?.rowNumber ?? "",
      "Prior Sales XLS Rows": excelRowRanges(oldLines.map((line) => line.rowNumber)),
      "Prior Sales Line Count": oldLines.length,
      "GroupWise Candidate Rows": excelRowRanges(relatedItems.flatMap((item) =>
        String(item["GroupWise XLS Candidate Rows"] ?? "")
          .split(", ")
          .flatMap((part) => {
            if (!part) return []
            if (!part.includes("-")) return [Number(part)]
            const [from, to] = part.split("-").map(Number)
            return Array.from({ length: to - from + 1 }, (_, index) => from + index)
          })
          .filter(Number.isFinite),
      )),
      "Budget XLS Candidate Rows": excelRowRanges(budgetMatches.map((match) => match.rowNumber)),
      "Monthly Budget": budgetMatches[0] ? asNumber(budgetMatches[0].row.MonthlyBudget) : null,
      "Used Budget": budgetMatches[0] ? asNumber(budgetMatches[0].row.UsedBudget) : null,
      "Remaining Budget": budgetMatches[0] ? asNumber(budgetMatches[0].row.RemainingBudget) : null,
      "Presence: Updated Orders": currentHeader ? "Yes" : "No",
      "Presence: Updated Sales": currentLines.length > 0 ? "Yes" : "No",
      "Presence: Refund": refund ? "Yes" : "No",
      "Presence: Prior Orders": oldHeader ? "Yes" : "No",
      "Presence: Prior Sales": oldLines.length > 0 ? "Yes" : "No",
      "Lookup Key": [
        `Branch=${branch}`,
        `OrderNo=${identitySource.OrderNo ?? ""}`,
        `TransactionNo=${identitySource.TransactionNo ?? ""}`,
        `Date=${dateKey(identitySource.CreatedOn ?? identitySource.OrderCreatedDT)}`,
        `User=${identitySource.UserDetails ?? firstLine?.UserDetails ?? ""}`,
      ].join(" | "),
    }
  })

  const reasonRows: JsonRow[] = remainingReport.categories.flatMap((category) => {
    const includedIds = category.legacyOrderIds.filter((id) => remainingSet.has(id))
    if (includedIds.length === 0) return []
    return [{
      "Blocker Code": category.code,
      "Blocker": category.title,
      "Orders": includedIds.length,
      "Why Not Imported": category.reason,
      "What Is Needed": category.requiredEvidence,
      "Legacy Order IDs": includedIds.join(", "),
    }]
  })

  const presenceCount = (field: string) =>
    orderRows.filter((row) => row[field] === "Yes").length
  const summaryRows: JsonRow[] = [
    { "Metric": "Organization", "Value": `${remainingReport.organization.name} only (ID ${remainingReport.organization.id}, code ${remainingReport.organization.code})`, "Notes": "No other organization is included." },
    { "Metric": "Known legacy order IDs", "Value": remainingReport.counts.knownLegacyOrderIds, "Notes": "Union of known prior order and sales reports." },
    { "Metric": "Imported order IDs", "Value": remainingReport.counts.importedLegacyOrderIds, "Notes": `${remainingReport.counts.importedBeforeIncrementalBatch} original + ${remainingReport.counts.importedInIncrementalBatch} safe incremental.` },
    { "Metric": "All remaining unimported order IDs before report exclusions", "Value": remainingReport.counts.remainingNotSafeToImport, "Notes": "Original complete exception population." },
    { "Metric": "Cancelled orders excluded", "Value": cancelledIds.length, "Notes": "Excluded from every detail sheet in this filtered workbook." },
    { "Metric": "Refund-evidence orders excluded", "Value": refundedIds.length, "Notes": "Excluded from every detail sheet in this filtered workbook." },
    { "Metric": "Orders included in this filtered workbook", "Value": remainingIds.length, "Notes": "Every included ID appears once in Unimported Orders." },
    { "Metric": "Orders found in updated Orders Excel", "Value": presenceCount("Presence: Updated Orders"), "Notes": basename(paths.updatedOrdersExcel) },
    { "Metric": "Orders with lines in updated Sales Excel", "Value": presenceCount("Presence: Updated Sales"), "Notes": basename(paths.updatedSalesExcel) },
    { "Metric": "Orders found in Refund Excel", "Value": presenceCount("Presence: Refund"), "Notes": basename(paths.refundExcel) },
    { "Metric": "Orders found in prior Orders Excel", "Value": presenceCount("Presence: Prior Orders"), "Notes": basename(paths.priorOrdersExcel) },
    { "Metric": "Orders with lines in prior Sales Excel", "Value": presenceCount("Presence: Prior Sales"), "Notes": basename(paths.priorSalesExcel) },
    { "Metric": "Selected item rows", "Value": orderItems.length, "Notes": "Updated Sales is preferred; prior Sales is used only when the order disappeared from the updated Sales export." },
    { "Metric": "How to locate an order", "Value": "Start with Primary Excel Lookup", "Notes": "The Excel row numbers include the header row. Verify using Order No + Transaction No + Branch + Date + User." },
    { "Metric": "Candidate-match warning", "Value": "GroupWise and product summaries do not expose Legacy Order ID", "Notes": "Their row references are candidates matched by date, registration/user, group/location, and item; they are not authoritative one-to-one order links." },
  ]

  const sourceRows: JsonRow[] = [
    {
      "Source": "Updated Orders",
      "File": basename(paths.updatedOrdersExcel),
      "Path Relative to Workbook": basename(paths.updatedOrdersExcel),
      "Role": "Authoritative updated order header/status lookup.",
      "Row Reference Type": "Exact; normalized order headers were validated row-for-row against this Excel file.",
    },
    {
      "Source": "Updated Sales",
      "File": basename(paths.updatedSalesExcel),
      "Path Relative to Workbook": basename(paths.updatedSalesExcel),
      "Role": "Updated item lines and visible order lookup fields.",
      "Row Reference Type": "Exact; orderPurchaseReport JSON was validated row-for-row against this Excel file.",
    },
    {
      "Source": "Refunds",
      "File": basename(paths.refundExcel),
      "Path Relative to Workbook": basename(paths.refundExcel),
      "Role": "Authoritative refund evidence.",
      "Row Reference Type": "Exact; refund JSON was validated row-for-row against this Excel file.",
    },
    {
      "Source": "GroupWise",
      "File": basename(paths.groupWiseExcel),
      "Path Relative to Workbook": basename(paths.groupWiseExcel),
      "Role": "Candidate item-code, rate, ordered quantity, delivered quantity, and delivered-value evidence.",
      "Row Reference Type": "Candidate only because the report has no Legacy Order ID.",
    },
    {
      "Source": "Budget",
      "File": basename(paths.budgetExcel),
      "Path Relative to Workbook": basename(paths.budgetExcel),
      "Role": "Candidate branch/month budget context.",
      "Row Reference Type": "Matched by branch and order date within budget tenure.",
    },
    {
      "Source": "Prior Orders",
      "File": basename(paths.priorOrdersExcel),
      "Path Relative to Workbook": relative(updatedRoot, paths.priorOrdersExcel),
      "Role": "Earlier order header/status evidence, including IDs omitted from the updated export.",
      "Row Reference Type": "Exact; prior order JSON was validated row-for-row against this Excel file.",
    },
    {
      "Source": "Prior Sales",
      "File": basename(paths.priorSalesExcel),
      "Path Relative to Workbook": relative(updatedRoot, paths.priorSalesExcel),
      "Role": "Earlier item evidence, including lines omitted from the updated export.",
      "Row Reference Type": "Exact; prior sales JSON was validated row-for-row against this Excel file.",
    },
    {
      "Source": "Product Summary",
      "File": basename(paths.productSummaryJson),
      "Path Relative to Workbook": basename(paths.productSummaryJson),
      "Role": "Candidate product price, quantity, and status evidence.",
      "Row Reference Type": "Candidate JSON array position; this source has no Legacy Order ID.",
    },
    {
      "Source": "User Product Summary",
      "File": basename(paths.userProductSummaryJson),
      "Path Relative to Workbook": basename(paths.userProductSummaryJson),
      "Role": "Candidate user/product price, quantity, and status evidence.",
      "Row Reference Type": "Candidate JSON array position; this source has no Legacy Order ID.",
    },
  ]

  assert(orderRows.length === 53, `Expected 53 order rows, found ${orderRows.length}`)
  assert(new Set(orderRows.map((row) => row["Legacy Order ID"])).size === 53, "Order rows contain duplicate IDs")
  assert(
    orderRows.every((row) =>
      row["Current Interpretation"] !== "Cancelled"
      && row["Current Interpretation"] !== "Refund evidence"),
    "Filtered order rows still contain a cancelled or refunded order",
  )
  assert(
    orderRows.every((row) =>
      row["Presence: Updated Orders"] === "Yes"
      || row["Presence: Updated Sales"] === "Yes"
      || row["Presence: Prior Orders"] === "Yes"
      || row["Presence: Prior Sales"] === "Yes"),
    "At least one order has no traceable source row",
  )

  const workbook = XLSX.utils.book_new()
  workbook.Props = {
    Title: "K-Electric Unimported Legacy Orders — Cancelled and Refunded Excluded",
    Subject: "53 unimported K-Electric orders with cancelled and refunded orders excluded",
    Author: "OneFlow",
    CreatedDate: new Date(),
  }

  addSheet(workbook, "Summary", summaryRows)
  addSheet(workbook, "Unimported Orders", orderRows, {
    dateHeaders: ["Order Date", "Created On", "Last Updated"],
    moneyHeaders: [
      "Reported Subtotal",
      "Raw Unit Price × Qty",
      "Raw vs Reported Difference",
      "Discount",
      "Service Charges",
      "Tax",
      "Grand Total",
      "Refund Amount",
      "Refund Tax",
      "Monthly Budget",
      "Used Budget",
      "Remaining Budget",
    ],
    integerHeaders: [
      "Legacy Order ID",
      "StatusID",
      "DeliveryStatus",
      "Order No",
      "Transaction No",
      "Selected Item Lines",
      "Updated Sales Line Count",
      "Prior Sales Line Count",
    ],
  })
  addSheet(workbook, "Order Items", orderItems, {
    dateHeaders: ["Order Date"],
    moneyHeaders: [
      "Raw Unit Price (JSON)",
      "Raw Extended Value",
      "Reported Order Subtotal",
      "Reported Order Tax",
      "Reported Order Grand Total",
    ],
    integerHeaders: ["Legacy Order ID", "Order No", "Transaction No"],
  })
  addSheet(workbook, "Reason Guide", reasonRows, {
    integerHeaders: ["Orders"],
  })
  addSheet(workbook, "Source Files", sourceRows)

  XLSX.writeFile(workbook, outputPath, {
    bookType: "xlsx",
    compression: true,
  })

  const validationWorkbook = XLSX.readFile(outputPath)
  const validateSheetCount = (sheetName: string, expected: number) => {
    const sheet = validationWorkbook.Sheets[sheetName]
    assert(sheet, `Output workbook is missing sheet ${sheetName}`)
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null })
    assert(rows.length === expected, `${sheetName}: expected ${expected} rows, found ${rows.length}`)
  }
  validateSheetCount("Unimported Orders", 53)
  validateSheetCount("Order Items", orderItems.length)
  validateSheetCount("Reason Guide", reasonRows.length)

  console.log(JSON.stringify({
    status: "PASS",
    outputPath,
    sheets: validationWorkbook.SheetNames,
    counts: {
      orders: orderRows.length,
      uniqueOrderIds: new Set(orderRows.map((row) => row["Legacy Order ID"])).size,
      cancelledOrdersExcluded: cancelledIds.length,
      refundedOrdersExcluded: refundedIds.length,
      itemRows: orderItems.length,
      reasonCategories: reasonRows.length,
      updatedOrdersFound: presenceCount("Presence: Updated Orders"),
      updatedSalesFound: presenceCount("Presence: Updated Sales"),
      priorOrdersFound: presenceCount("Presence: Prior Orders"),
      priorSalesFound: presenceCount("Presence: Prior Sales"),
    },
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
