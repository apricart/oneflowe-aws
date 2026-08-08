#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import * as XLSX from "xlsx"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

type SheetRow = Record<string, unknown>
type DbRow = Record<string, any>

const ORGANIZATION = { id: 10, code: "0001", name: "K-Electric" }
const SOURCE_SYSTEM = "KE_LOGISTICS"
const INPUT = resolve(process.argv[2] || "Orders (12).xls")
const RUN_DATE = new Date().toISOString().slice(0, 10)
const OUTPUT_DIR = resolve(process.argv[3] || `updatedReports/ke-orders-sheet-live-comparison-${RUN_DATE}`)
const JSON_OUTPUT = resolve(OUTPUT_DIR, "comparison.json")
const MARKDOWN_OUTPUT = resolve(OUTPUT_DIR, "summary.md")
const EXCEL_OUTPUT = resolve(OUTPUT_DIR, "k-electric-orders-reconciliation-tracker.xlsx")

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en")
}

function normalizeUserDisplay(value: unknown): string {
  return normalize(value)
    .replace(/\./g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*$/, "")
    .trim()
}

function dateKey(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10)
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`
  }
  const text = String(value ?? "").trim()
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/)
  if (iso) return iso[1]
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/)
  if (slash) {
    const year = slash[3].length === 2 ? Number(slash[3]) + 2000 : Number(slash[3])
    return `${year}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`
  }
  return null
}

function cents(value: unknown): number | null {
  if (value == null || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) : null
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function integerText(value: unknown): string {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? String(Math.trunc(parsed)) : normalize(value)
}

function identityKey(row: {
  location: unknown
  transactionNo: unknown
  orderNo: unknown
  date: unknown
}): string | null {
  const location = normalize(row.location)
  const transactionNo = integerText(row.transactionNo)
  const orderNo = integerText(row.orderNo)
  const date = dateKey(row.date)
  if (!location || !transactionNo || !orderNo || !date) return null
  return [location, transactionNo, orderNo, date].join("|")
}

function sourceHeader(payload: unknown): DbRow {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {}
  const record = payload as DbRow
  const nested = record.sourceHeader ?? record.source_header ?? record.header
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested : record
}

function statusDistribution<T>(rows: T[], selector: (row: T) => unknown): Record<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const label = String(selector(row) ?? "<null>").trim() || "<empty>"
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}

function differenceFieldDistribution(rows: Array<{ databaseDifferences: Array<{ field: string }> }>): Record<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    for (const difference of row.databaseDifferences) {
      counts.set(difference.field, (counts.get(difference.field) ?? 0) + 1)
    }
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}

function dbBusinessStatus(row: DbRow): string {
  const status = normalize(row.status).replace(/\s+/g, "_")
  const fulfillment = normalize(row.fulfillment_status).replace(/\s+/g, "_")
  if (status === "refunded") return "Refunded"
  if (status === "rejected" || status === "cancelled" || status === "canceled") return "Cancelled"
  if (fulfillment === "delivered" || status === "fulfilled") return "Delivered"
  if (fulfillment === "out_for_delivery") return "OutForDelivery"
  if (fulfillment === "in_process") return "InProcess"
  if (status === "pending") return "Pending"
  if (status === "approved") return "Approved"
  return row.status || row.fulfillment_status || "Unknown"
}

function statusCompatible(sheetStatus: unknown, row: DbRow): boolean {
  const sheet = normalize(sheetStatus).replace(/\s+/g, "")
  const db = normalize(dbBusinessStatus(row)).replace(/\s+/g, "")
  if (sheet === "partial") return db === "delivered"
  return sheet === db
}

function duplicateKeys<T>(rows: T[], selector: (row: T) => string | null): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = selector(row)
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

function markdownEscape(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

function addTrackingWorksheet(
  workbook: XLSX.WorkBook,
  name: string,
  rows: Array<Record<string, unknown>>,
  widths: Record<string, number> = {},
  moneyColumns: string[] = [],
) {
  const worksheet = XLSX.utils.json_to_sheet(rows, { skipHeader: false })
  const headers = rows.length ? Object.keys(rows[0]) : []
  if (headers.length) {
    worksheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) }
    worksheet["!cols"] = headers.map((header) => ({ wch: widths[header] ?? Math.min(42, Math.max(12, header.length + 2)) }))
    worksheet["!rows"] = [{ hpt: 30 }]
    ;(worksheet as any)["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" }
    for (let column = 0; column < headers.length; column += 1) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: 0, c: column })]
      if (!cell) continue
      cell.s = {
        font: { bold: true, color: { rgb: "111827" } },
        fill: { patternType: "solid", fgColor: { rgb: "E5E7EB" } },
        alignment: { vertical: "center", wrapText: true },
        border: { bottom: { style: "thin", color: { rgb: "9CA3AF" } } },
      }
    }
    for (const header of moneyColumns) {
      const column = headers.indexOf(header)
      if (column < 0) continue
      for (let row = 1; row <= rows.length; row += 1) {
        const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: column })]
        if (cell && cell.t === "n") cell.z = "#,##0.00"
      }
    }
  }
  XLSX.utils.book_append_sheet(workbook, worksheet, name)
}

function writeStyledTrackingWorkbook(workbook: XLSX.WorkBook, output: string) {
  const raw = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true, cellStyles: true }) as Buffer
  const files = unzipSync(new Uint8Array(raw))
  const stylesPath = "xl/styles.xml"
  let styles = strFromU8(files[stylesPath])
  styles = styles
    .replace(
      /<fonts count="1">([\s\S]*?)<\/fonts>/,
      '<fonts count="2">$1<font><b/><sz val="12"/><color rgb="FF111827"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>',
    )
    .replace(
      /<fills count="2">([\s\S]*?)<\/fills>/,
      '<fills count="3">$1<fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/><bgColor indexed="64"/></patternFill></fill></fills>',
    )
    .replace(
      /<borders count="1">([\s\S]*?)<\/borders>/,
      '<borders count="2">$1<border><left/><right/><top/><bottom style="thin"><color rgb="FF9CA3AF"/></bottom><diagonal/></border></borders>',
    )
    .replace(
      /<cellXfs count="2">([\s\S]*?)<\/cellXfs>/,
      '<cellXfs count="3">$1<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs>',
    )
  files[stylesPath] = strToU8(styles)

  for (let index = 1; index <= workbook.SheetNames.length; index += 1) {
    const worksheetPath = `xl/worksheets/sheet${index}.xml`
    let xml = strFromU8(files[worksheetPath])
    xml = xml.replace(
      '<sheetView workbookViewId="0"/>',
      '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>',
    )
    xml = xml.replace(/<row r="1"([\s\S]*?)<\/row>/, (headerRow) =>
      headerRow.replace(/<c r="([A-Z]+)1"/g, (_cell, column: string) => `<c r="${column}1" s="2"`),
    )
    files[worksheetPath] = strToU8(xml)
  }

  writeFileSync(output, Buffer.from(zipSync(files, { level: 6 })))
}

async function main() {
  const workbook = XLSX.readFile(INPUT, { cellDates: true })
  if (workbook.SheetNames.length !== 1) throw new Error(`Expected one worksheet, found ${workbook.SheetNames.length}`)
  const worksheetName = workbook.SheetNames[0]
  const sheetRows = XLSX.utils.sheet_to_json<SheetRow>(workbook.Sheets[worksheetName], { defval: null, raw: true })
  const requiredHeaders = ["Location", "TransactionNo", "OrderNo", "Date", "UserDetails", "LocationGroup", "GrandTotal", "OrderType", "Order Status"]
  const actualHeaders = new Set(sheetRows.flatMap((row) => Object.keys(row)))
  const missingHeaders = requiredHeaders.filter((header) => !actualHeaders.has(header))
  if (missingHeaders.length) throw new Error(`Workbook is missing required headers: ${missingHeaders.join(", ")}`)

  const sheet = sheetRows.map((row, index) => ({
    rowNumber: index + 2,
    identityKey: identityKey({
      location: row.Location,
      transactionNo: row.TransactionNo,
      orderNo: row.OrderNo,
      date: row.Date,
    }),
    location: String(row.Location ?? "").trim(),
    transactionNo: Number(row.TransactionNo),
    orderNo: Number(row.OrderNo),
    date: dateKey(row.Date),
    userDetails: String(row.UserDetails ?? "").trim(),
    locationGroup: String(row.LocationGroup ?? "").trim(),
    grandTotalCents: cents(row.GrandTotal),
    orderType: String(row.OrderType ?? "").trim(),
    orderStatus: String(row["Order Status"] ?? "").trim(),
  }))
  const sheetInvalidIdentity = sheet.filter((row) => !row.identityKey)
  const sheetDuplicateIdentities = duplicateKeys(sheet, (row) => row.identityKey)
  if (sheetInvalidIdentity.length || sheetDuplicateIdentities.length) {
    throw new Error(`Workbook identity gate failed: ${sheetInvalidIdentity.length} invalid and ${sheetDuplicateIdentities.length} duplicate keys`)
  }

  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  let organization: DbRow
  let allOrderSummary: DbRow[]
  let liveRows: DbRow[]
  try {
    await client.query("begin transaction isolation level repeatable read read only")
    await client.query("set local statement_timeout = '120s'")
    organization = (await client.query(
      "select id, code, name, status from organizations where id = $1",
      [ORGANIZATION.id],
    )).rows[0] ?? null
    if (!organization
      || Number(organization.id) !== ORGANIZATION.id
      || organization.code !== ORGANIZATION.code
      || organization.name !== ORGANIZATION.name
      || normalize(organization.status) !== "active") {
      throw new Error(`Production tenant identity gate failed: ${JSON.stringify(organization)}`)
    }

    allOrderSummary = (await client.query(`
      select
        o.status,
        o.fulfillment_status,
        count(*)::int as orders,
        count(loi.id)::int as legacy_imported_orders
      from orders o
      left join legacy_order_imports loi
        on loi.order_id = o.id
       and loi.organization_id = $1
       and loi.source_system = $2
      where o.organization_id = $1
      group by o.status, o.fulfillment_status
      order by o.status, o.fulfillment_status
    `, [ORGANIZATION.id, SOURCE_SYSTEM])).rows

    liveRows = (await client.query(`
      select
        loi.legacy_order_id,
        loi.source_payload,
        loi.source_checksum,
        loi.created_at as ledger_created_at,
        o.id as database_order_id,
        o.tid,
        o.status,
        o.fulfillment_status,
        o.subtotal_cents,
        o.tax_cents,
        o.total_cents,
        o.refund_amount_cents,
        to_char(o.created_at at time zone 'Asia/Karachi', 'YYYY-MM-DD') as database_created_date,
        o.created_at,
        o.delivered_at,
        o.refunded_at,
        b.id as branch_id,
        b.name as branch_name,
        u.id as creator_user_id,
        u.full_name as creator_full_name,
        count(oi.id)::int as item_rows
      from legacy_order_imports loi
      join orders o
        on o.id = loi.order_id
       and o.organization_id = loi.organization_id
      join branches b
        on b.id = o.branch_id
       and b.organization_id = o.organization_id
      join users u
        on u.id = o.created_by_user_id
       and u.organization_id = o.organization_id
      left join order_items oi
        on oi.order_id = o.id
       and oi.organization_id = o.organization_id
      where loi.organization_id = $1
        and loi.source_system = $2
      group by loi.id, o.id, b.id, u.id
      order by loi.legacy_order_id
    `, [ORGANIZATION.id, SOURCE_SYSTEM])).rows
    await client.query("rollback")
  } catch (error) {
    await client.query("rollback").catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }

  const live: DbRow[] = liveRows.map((row): DbRow => {
    const header = sourceHeader(row.source_payload)
    const sourceLocation = header.LocationName ?? header.Location
    const sourceDate = header.OrderCreatedDT ?? header.CreatedOn
    return {
      ...row,
      sourceHeader: header,
      identityKey: identityKey({
        location: sourceLocation,
        transactionNo: header.TransactionNo,
        orderNo: header.OrderNo,
        date: sourceDate,
      }),
      sourceLocation: String(sourceLocation ?? "").trim(),
      sourceTransactionNo: numberOrNull(header.TransactionNo),
      sourceOrderNo: numberOrNull(header.OrderNo),
      sourceDate: dateKey(sourceDate),
      sourceUserDetails: String(header.UserDetails ?? header.OrderTakerName ?? "").trim(),
      sourceLocationGroup: String(header.LocationGroup ?? "").trim(),
      sourceGrandTotalCents: cents(header.GrandTotal),
      sourceOrderType: String(header.OrderType ?? "").trim(),
      databaseBusinessStatus: dbBusinessStatus(row),
    }
  })

  const liveInvalidIdentity = live
    .filter((row) => !row.identityKey)
    .map((row) => ({ legacyOrderId: row.legacy_order_id, tid: row.tid }))
  const liveDuplicateIdentities = duplicateKeys(live, (row) => row.identityKey)
  const matches = new Map<number, { liveRow: DbRow; matchMethod: string }>()
  const matchedLiveIds = new Set<number>()
  const joinedKey = (...values: unknown[]): string | null => {
    if (values.some((value) => value == null || value === "" || (typeof value === "number" && !Number.isFinite(value)))) return null
    return values.join("|")
  }
  const matchPass = (
    matchMethod: string,
    sheetKey: (row: typeof sheet[number]) => string | null,
    liveKey: (row: DbRow) => string | null,
  ) => {
    const availableSheet = sheet.filter((row) => !matches.has(row.rowNumber))
    const availableLive = live.filter((row) => !matchedLiveIds.has(Number(row.legacy_order_id)))
    const sheetGroups = new Map<string, typeof availableSheet>()
    const liveGroups = new Map<string, DbRow[]>()
    for (const row of availableSheet) {
      const key = sheetKey(row)
      if (!key) continue
      const group = sheetGroups.get(key) ?? []
      group.push(row)
      sheetGroups.set(key, group)
    }
    for (const row of availableLive) {
      const key = liveKey(row)
      if (!key) continue
      const group = liveGroups.get(key) ?? []
      group.push(row)
      liveGroups.set(key, group)
    }
    for (const [key, sheetGroup] of sheetGroups) {
      const liveGroup = liveGroups.get(key) ?? []
      if (sheetGroup.length !== 1 || liveGroup.length !== 1) continue
      const sheetRow = sheetGroup[0]
      const liveRow = liveGroup[0]
      matches.set(sheetRow.rowNumber, { liveRow, matchMethod })
      matchedLiveIds.add(Number(liveRow.legacy_order_id))
    }
  }

  matchPass("EXACT_SOURCE_IDENTITY", (row) => row.identityKey, (row) => row.identityKey)
  matchPass(
    "DATE_TRANSACTION_ORDER_TOTAL",
    (row) => joinedKey(row.date, row.transactionNo, row.orderNo, row.grandTotalCents),
    (row) => joinedKey(row.sourceDate, row.sourceTransactionNo, row.sourceOrderNo, row.sourceGrandTotalCents),
  )
  const learnedBranchAliases = new Map<string, string>()
  for (const sheetRow of sheet) {
    const exactMatch = matches.get(sheetRow.rowNumber)
    if (!exactMatch) continue
    const canonical = normalize(exactMatch.liveRow.branch_name)
    if (!canonical) continue
    for (const alias of [normalize(sheetRow.location), normalize(exactMatch.liveRow.sourceLocation), canonical]) {
      if (!alias) continue
      const existing = learnedBranchAliases.get(alias)
      if (!existing || existing === canonical) learnedBranchAliases.set(alias, canonical)
    }
  }
  const canonicalBranch = (value: unknown): string => learnedBranchAliases.get(normalize(value)) ?? normalize(value)
  matchPass(
    "CANONICAL_BRANCH_DATE_TRANSACTION_ORDER",
    (row) => joinedKey(canonicalBranch(row.location), row.date, row.transactionNo, row.orderNo),
    (row) => joinedKey(canonicalBranch(row.branch_name), row.sourceDate, row.sourceTransactionNo, row.sourceOrderNo),
  )
  matchPass(
    "CANONICAL_BRANCH_DATE_ORDER_TOTAL",
    (row) => joinedKey(canonicalBranch(row.location), row.date, row.orderNo, row.grandTotalCents),
    (row) => joinedKey(canonicalBranch(row.branch_name), row.sourceDate, row.sourceOrderNo, row.sourceGrandTotalCents),
  )
  matchPass(
    "CANONICAL_BRANCH_DATE_TOTAL",
    (row) => joinedKey(canonicalBranch(row.location), row.date, row.grandTotalCents),
    (row) => joinedKey(canonicalBranch(row.branch_name), row.sourceDate, row.sourceGrandTotalCents),
  )
  matchPass(
    "CANONICAL_BRANCH_DATE_ORDER",
    (row) => joinedKey(canonicalBranch(row.location), row.date, row.orderNo),
    (row) => joinedKey(canonicalBranch(row.branch_name), row.sourceDate, row.sourceOrderNo),
  )

  const matched = sheet
    .filter((row) => matches.has(row.rowNumber))
    .map((sheetRow) => {
      const { liveRow, matchMethod } = matches.get(sheetRow.rowNumber)!
      const sourceDifferences: Array<{ field: string; sheet: unknown; liveLedger: unknown }> = []
      const databaseDifferences: Array<{ field: string; sheet: unknown; liveDatabase: unknown }> = []
      const compareSource = (field: string, left: unknown, right: unknown, transform: (value: unknown) => unknown = normalize) => {
        if (transform(left) !== transform(right)) sourceDifferences.push({ field, sheet: left, liveLedger: right })
      }
      const compareDatabase = (field: string, left: unknown, right: unknown, transform: (value: unknown) => unknown = normalize) => {
        if (transform(left) !== transform(right)) databaseDifferences.push({ field, sheet: left, liveDatabase: right })
      }

      compareSource("Location", sheetRow.location, liveRow.sourceLocation)
      compareSource("TransactionNo", sheetRow.transactionNo, liveRow.sourceTransactionNo, integerText)
      compareSource("OrderNo", sheetRow.orderNo, liveRow.sourceOrderNo, integerText)
      compareSource("Date", sheetRow.date, liveRow.sourceDate, dateKey)
      compareSource("UserDetails", sheetRow.userDetails, liveRow.sourceUserDetails)
      compareSource("LocationGroup", sheetRow.locationGroup, liveRow.sourceLocationGroup)
      compareSource("GrandTotal", sheetRow.grandTotalCents, liveRow.sourceGrandTotalCents, Number)
      compareSource("OrderType", sheetRow.orderType, liveRow.sourceOrderType)

      compareDatabase("Location", sheetRow.location, liveRow.branch_name)
      compareDatabase("Date", sheetRow.date, liveRow.database_created_date, dateKey)
      compareDatabase("UserDetails", sheetRow.userDetails, liveRow.creator_full_name)
      compareDatabase("GrandTotal", sheetRow.grandTotalCents, Number(liveRow.total_cents), Number)
      if (!statusCompatible(sheetRow.orderStatus, liveRow)) {
        databaseDifferences.push({ field: "Order Status", sheet: sheetRow.orderStatus, liveDatabase: liveRow.databaseBusinessStatus })
      }

      return {
        sheetRowNumber: sheetRow.rowNumber,
        legacyOrderId: Number(liveRow.legacy_order_id),
        databaseOrderId: Number(liveRow.database_order_id),
        tid: liveRow.tid,
        identity: {
          location: sheetRow.location,
          transactionNo: sheetRow.transactionNo,
          orderNo: sheetRow.orderNo,
          date: sheetRow.date,
        },
        sheetStatus: sheetRow.orderStatus,
        databaseStatus: liveRow.status,
        databaseFulfillmentStatus: liveRow.fulfillment_status,
        databaseBusinessStatus: liveRow.databaseBusinessStatus,
        itemRows: Number(liveRow.item_rows),
        matchMethod,
        sheet: { ...sheetRow },
        liveLedger: {
          location: liveRow.sourceLocation,
          transactionNo: liveRow.sourceTransactionNo,
          orderNo: liveRow.sourceOrderNo,
          date: liveRow.sourceDate,
          userDetails: liveRow.sourceUserDetails,
          locationGroup: liveRow.sourceLocationGroup,
          grandTotalCents: liveRow.sourceGrandTotalCents,
          orderType: liveRow.sourceOrderType,
        },
        database: {
          branchName: liveRow.branch_name,
          createdDate: liveRow.database_created_date,
          creatorFullName: liveRow.creator_full_name,
          subtotalCents: Number(liveRow.subtotal_cents),
          taxCents: Number(liveRow.tax_cents),
          totalCents: Number(liveRow.total_cents),
          refundAmountCents: liveRow.refund_amount_cents == null ? null : Number(liveRow.refund_amount_cents),
          status: liveRow.status,
          fulfillmentStatus: liveRow.fulfillment_status,
          businessStatus: liveRow.databaseBusinessStatus,
          itemRows: Number(liveRow.item_rows),
        },
        sourceDifferences,
        databaseDifferences,
      }
    })

  const sheetOnly = sheet
    .filter((row) => !matches.has(row.rowNumber))
    .map((row) => ({
      ...row,
      classification: normalize(row.orderStatus) === "cancelled"
        ? "CANCELLED_NOT_IN_LIVE_LEGACY_IMPORTS"
        : normalize(row.orderStatus).replace(/\s+/g, "") === "inprocess"
          ? "NON_FINAL_NOT_IN_LIVE_LEGACY_IMPORTS"
          : "NON_CANCELLED_NOT_IN_LIVE_LEGACY_IMPORTS",
    }))
  const liveOnly = live
    .filter((row) => !matchedLiveIds.has(Number(row.legacy_order_id)))
    .map((row) => ({
      legacyOrderId: Number(row.legacy_order_id),
      databaseOrderId: Number(row.database_order_id),
      tid: row.tid,
      sourceLocation: row.sourceLocation,
      sourceTransactionNo: row.sourceTransactionNo,
      sourceOrderNo: row.sourceOrderNo,
      sourceDate: row.sourceDate,
      sourceGrandTotalCents: row.sourceGrandTotalCents,
      databaseBranchName: row.branch_name,
      databaseCreatedDate: row.database_created_date,
      databaseTotalCents: Number(row.total_cents),
      databaseSubtotalCents: Number(row.subtotal_cents),
      databaseTaxCents: Number(row.tax_cents),
      databaseRefundAmountCents: row.refund_amount_cents == null ? null : Number(row.refund_amount_cents),
      databaseCreatorFullName: row.creator_full_name,
      databaseItemRows: Number(row.item_rows),
      sourceUserDetails: row.sourceUserDetails,
      sourceLocationGroup: row.sourceLocationGroup,
      sourceOrderType: row.sourceOrderType,
      databaseStatus: row.status,
      databaseFulfillmentStatus: row.fulfillment_status,
      databaseBusinessStatus: row.databaseBusinessStatus,
    }))
  const sourceMismatchRows = matched.filter((row) => row.sourceDifferences.length > 0)
  const databaseMismatchRows = matched.filter((row) => row.databaseDifferences.length > 0)
  const businessDataMismatchRows = matched.filter((row) => row.databaseDifferences.some((difference) => !["UserDetails", "Location"].includes(difference.field)))
  const locationLabelMismatchRows = matched.filter((row) => row.databaseDifferences.some((difference) => difference.field === "Location"))
  const userAttributionMismatchRows = matched.filter((row) => row.databaseDifferences.some((difference) => difference.field === "UserDetails"))
  const cosmeticUserAttributionMismatchRows = userAttributionMismatchRows.filter((row) => {
    const difference = row.databaseDifferences.find((entry) => entry.field === "UserDetails")
    return difference && normalizeUserDisplay(difference.sheet) === normalizeUserDisplay(difference.liveDatabase)
  })
  const substantiveUserAttributionMismatchRows = userAttributionMismatchRows.filter((row) => {
    const difference = row.databaseDifferences.find((entry) => entry.field === "UserDetails")
    return difference && normalizeUserDisplay(difference.sheet) !== normalizeUserDisplay(difference.liveDatabase)
  })

  const totalLiveOrders = allOrderSummary.reduce((sum, row) => sum + Number(row.orders), 0)
  const totalLiveLegacyOrders = allOrderSummary.reduce((sum, row) => sum + Number(row.legacy_imported_orders), 0)
  const report = {
    generatedAt: new Date().toISOString(),
    mode: "PRODUCTION_READ_ONLY",
    databaseChanges: 0,
    scope: {
      organization,
      sourceSystem: SOURCE_SYSTEM,
      inputWorkbook: basename(INPUT),
      worksheet: worksheetName,
      primaryMatchingKey: ["Location", "TransactionNo", "OrderNo", "Date"],
      matchingNote: "The workbook has no legacy order ID. The unique four-field identity is used first. Unmatched rows are linked only through unique one-to-one fallback keys using the canonical database branch, date, and available order/transaction/total fields. Each result records its match method.",
      statusNote: "Partial in the source sheet is compatible with a delivered materialized order because the approved legacy-import policy stores accepted partial deliveries as DELIVERED.",
    },
    summary: {
      sheetRows: sheet.length,
      sheetStatusDistribution: statusDistribution(sheet, (row) => row.orderStatus),
      liveKElectricOrders: totalLiveOrders,
      liveKELegacyImportedOrders: live.length,
      liveKENonLegacyOrders: totalLiveOrders - totalLiveLegacyOrders,
      matchedSheetRows: matched.length,
      sheetRowsNotInLiveLegacyImports: sheetOnly.length,
      liveLegacyImportsNotInSheet: liveOnly.length,
      matchedRowsWithNoSourceLedgerDifferences: matched.length - sourceMismatchRows.length,
      matchedRowsWithSourceLedgerDifferences: sourceMismatchRows.length,
      matchedRowsWithNoMaterializedDatabaseDifferences: matched.length - databaseMismatchRows.length,
      matchedRowsWithMaterializedDatabaseDifferences: databaseMismatchRows.length,
      matchedRowsWithBusinessDataDifferences: businessDataMismatchRows.length,
      matchedRowsWithLocationLabelDifferences: locationLabelMismatchRows.length,
      matchedRowsWithUserAttributionDifferences: userAttributionMismatchRows.length,
      matchedRowsWithCosmeticUserDisplayDifferences: cosmeticUserAttributionMismatchRows.length,
      matchedRowsWithSubstantiveUserAttributionDifferences: substantiveUserAttributionMismatchRows.length,
      materializedDifferenceFieldDistribution: differenceFieldDistribution(databaseMismatchRows),
      matchMethodDistribution: statusDistribution(matched, (row) => row.matchMethod),
      sheetOnlyStatusDistribution: statusDistribution(sheetOnly, (row) => row.orderStatus),
      sheetOnlyClassificationDistribution: statusDistribution(sheetOnly, (row) => row.classification),
      liveOrderStateDistribution: Object.fromEntries(allOrderSummary.map((row) => [
        `${row.status}/${row.fulfillment_status}`,
        { orders: Number(row.orders), legacyImportedOrders: Number(row.legacy_imported_orders) },
      ])),
    },
    integrity: {
      sheetInvalidIdentityRows: sheetInvalidIdentity,
      sheetDuplicateIdentities,
      liveRowsWithoutPrimaryFourFieldIdentity: liveInvalidIdentity,
      liveDuplicateIdentities,
    },
    matchedRows: matched,
    sheetOnly,
    liveOnly,
    matchedRowsWithSourceLedgerDifferences: sourceMismatchRows,
    matchedRowsWithMaterializedDatabaseDifferences: databaseMismatchRows,
  }

  const sheetOnlyStatusRows = Object.entries(report.summary.sheetOnlyStatusDistribution)
    .map(([status, count]) => `| ${markdownEscape(status)} | ${count} |`)
    .join("\n") || "| None | 0 |"
  const liveOnlyRows = liveOnly.slice(0, 100).map((row) =>
    `| ${row.legacyOrderId} | ${markdownEscape(row.sourceLocation)} | ${row.sourceTransactionNo} | ${row.sourceOrderNo} | ${row.sourceDate} | ${markdownEscape(row.databaseStatus)}/${markdownEscape(row.databaseFulfillmentStatus)} |`,
  ).join("\n") || "| None |  |  |  |  |  |"
  const nonCancelledSheetOnly = sheetOnly.filter((row) => normalize(row.orderStatus) !== "cancelled")
  const nonCancelledRows = nonCancelledSheetOnly.slice(0, 100).map((row) =>
    `| ${row.rowNumber} | ${markdownEscape(row.location)} | ${row.transactionNo} | ${row.orderNo} | ${row.date} | ${markdownEscape(row.orderStatus)} | ${row.grandTotalCents} |`,
  ).join("\n") || "| None |  |  |  |  |  |  |"
  const mismatchRows = businessDataMismatchRows.slice(0, 100).map((row) =>
    `| ${row.sheetRowNumber} | ${row.legacyOrderId} | ${markdownEscape(row.identity.location)} | ${row.identity.transactionNo} | ${row.identity.orderNo} | ${row.identity.date} | ${markdownEscape(row.databaseDifferences.filter((difference) => !["UserDetails", "Location"].includes(difference.field)).map((difference) => difference.field).join(", "))} |`,
  ).join("\n") || "| None |  |  |  |  |  |  |"

  const markdown = `# K-Electric order sheet vs live database\n\n` +
    `Generated: ${report.generatedAt}\n\n` +
    `Mode: production read-only; database changes: 0.\n\n` +
    `## Summary\n\n` +
    `- Workbook rows: ${sheet.length}\n` +
    `- Live K-Electric orders: ${totalLiveOrders}\n` +
    `- Live K-Electric legacy-imported orders: ${live.length}\n` +
    `- Live K-Electric non-legacy orders: ${totalLiveOrders - totalLiveLegacyOrders}\n` +
    `- Workbook rows matched to live legacy imports: ${matched.length}\n` +
    `- Workbook rows not present in live legacy imports: ${sheetOnly.length}\n` +
    `- Live legacy imports absent from this workbook: ${liveOnly.length}\n` +
    `- Matched rows with business-data differences (status, amount, or date): ${businessDataMismatchRows.length}\n` +
    `- Matched rows with canonical location-label differences: ${locationLabelMismatchRows.length}\n` +
    `- Matched rows with cosmetic user-display differences: ${cosmeticUserAttributionMismatchRows.length}\n` +
    `- Matched rows with substantive user-attribution differences: ${substantiveUserAttributionMismatchRows.length}\n` +
    `- Matched rows with immutable source-ledger differences: ${sourceMismatchRows.length}\n\n` +
    `## Workbook-only rows by status\n\n` +
    `| Sheet status | Rows |\n| --- | ---: |\n${sheetOnlyStatusRows}\n\n` +
    `## Non-cancelled workbook rows not in live legacy imports\n\n` +
    `| Sheet row | Location | Transaction | Order | Date | Status | Grand total (cents) |\n| ---: | --- | ---: | ---: | --- | --- | ---: |\n${nonCancelledRows}\n\n` +
    `## Live legacy imports absent from this workbook\n\n` +
    `| Legacy order ID | Location | Transaction | Order | Date | Database state |\n| ---: | --- | ---: | ---: | --- | --- |\n${liveOnlyRows}\n\n` +
    `## Matched rows with business-data differences\n\n` +
    `| Sheet row | Legacy order ID | Location | Transaction | Order | Date | Different fields |\n| ---: | ---: | --- | ---: | ---: | --- | --- |\n${mismatchRows}\n\n` +
    `The detailed JSON report contains every workbook-only row, live-only legacy import, and field-level difference.\n`

  const substantiveUserIds = new Set(substantiveUserAttributionMismatchRows.map((row) => row.legacyOrderId))
  const allTrackingRows: Array<Record<string, unknown>> = []
  for (const row of matched) {
    const businessFields = row.databaseDifferences
      .filter((difference) => !["UserDetails", "Location"].includes(difference.field))
      .map((difference) => difference.field)
    const substantiveUserDifference = substantiveUserIds.has(row.legacyOrderId)
    const hasDisplayOrMetadataDifference = row.databaseDifferences.length > 0 || row.sourceDifferences.length > 0
    const actionRequired = businessFields.length > 0 || substantiveUserDifference
    const category = businessFields.length > 0
      ? "BOTH - BUSINESS DATA REVIEW"
      : substantiveUserDifference
        ? "BOTH - USER ATTRIBUTION REVIEW"
        : hasDisplayOrMetadataDifference
          ? "BOTH - DISPLAY / METADATA DIFFERENCE"
          : "BOTH - ALIGNED"
    allTrackingRows.push({
      "Tracking Key": `KE-LEGACY-${row.legacyOrderId}`,
      "Comparison Category": category,
      "Action Required": actionRequired ? "Yes" : "No",
      "Review Status": actionRequired ? "Open" : "No action",
      Owner: "",
      "Follow-up Notes": "",
      "Present in Sheet": "Yes",
      "Present in Database": "Yes",
      "Match Method": row.matchMethod,
      "Business Difference Fields": businessFields.join(", "),
      "Other DB Difference Fields": row.databaseDifferences
        .filter((difference) => !businessFields.includes(difference.field))
        .map((difference) => difference.field)
        .join(", "),
      "Source Ledger Difference Fields": row.sourceDifferences.map((difference) => difference.field).join(", "),
      "Sheet Row": row.sheet.rowNumber,
      "Sheet Location": row.sheet.location,
      "Sheet Transaction No": row.sheet.transactionNo,
      "Sheet Order No": row.sheet.orderNo,
      "Sheet Date": row.sheet.date,
      "Sheet User Details": row.sheet.userDetails,
      "Sheet Location Group": row.sheet.locationGroup,
      "Sheet Grand Total (PKR)": row.sheet.grandTotalCents == null ? null : row.sheet.grandTotalCents / 100,
      "Sheet Order Type": row.sheet.orderType,
      "Sheet Order Status": row.sheet.orderStatus,
      "DB Legacy Order ID": row.legacyOrderId,
      "DB Order ID": row.databaseOrderId,
      "DB TID": row.tid,
      "DB Branch": row.database.branchName,
      "DB Created Date": row.database.createdDate,
      "DB Creator": row.database.creatorFullName,
      "DB Subtotal (PKR)": row.database.subtotalCents / 100,
      "DB Tax (PKR)": row.database.taxCents / 100,
      "DB Grand Total (PKR)": row.database.totalCents / 100,
      "DB Refund Amount (PKR)": row.database.refundAmountCents == null ? null : row.database.refundAmountCents / 100,
      "DB Status": row.database.status,
      "DB Fulfillment Status": row.database.fulfillmentStatus,
      "DB Business Status": row.database.businessStatus,
      "DB Item Rows": row.database.itemRows,
    })
  }
  for (const row of sheetOnly) {
    const actionRequired = normalize(row.orderStatus) !== "cancelled"
    allTrackingRows.push({
      "Tracking Key": `SHEET-ROW-${row.rowNumber}`,
      "Comparison Category": actionRequired ? "SHEET ONLY - REFUNDED REVIEW" : "SHEET ONLY - CANCELLED",
      "Action Required": actionRequired ? "Yes" : "No",
      "Review Status": actionRequired ? "Open" : "Expected exclusion",
      Owner: "",
      "Follow-up Notes": "",
      "Present in Sheet": "Yes",
      "Present in Database": "No",
      "Match Method": "",
      "Business Difference Fields": "Order missing from database",
      "Other DB Difference Fields": "",
      "Source Ledger Difference Fields": "",
      "Sheet Row": row.rowNumber,
      "Sheet Location": row.location,
      "Sheet Transaction No": row.transactionNo,
      "Sheet Order No": row.orderNo,
      "Sheet Date": row.date,
      "Sheet User Details": row.userDetails,
      "Sheet Location Group": row.locationGroup,
      "Sheet Grand Total (PKR)": row.grandTotalCents == null ? null : row.grandTotalCents / 100,
      "Sheet Order Type": row.orderType,
      "Sheet Order Status": row.orderStatus,
      "DB Legacy Order ID": null,
      "DB Order ID": null,
      "DB TID": "",
      "DB Branch": "",
      "DB Created Date": "",
      "DB Creator": "",
      "DB Subtotal (PKR)": null,
      "DB Tax (PKR)": null,
      "DB Grand Total (PKR)": null,
      "DB Refund Amount (PKR)": null,
      "DB Status": "",
      "DB Fulfillment Status": "",
      "DB Business Status": "",
      "DB Item Rows": null,
    })
  }
  for (const row of liveOnly) {
    allTrackingRows.push({
      "Tracking Key": `KE-LEGACY-${row.legacyOrderId}`,
      "Comparison Category": "DATABASE ONLY - REVIEW",
      "Action Required": "Yes",
      "Review Status": "Open",
      Owner: "",
      "Follow-up Notes": "",
      "Present in Sheet": "No",
      "Present in Database": "Yes",
      "Match Method": "",
      "Business Difference Fields": "Order missing from sheet",
      "Other DB Difference Fields": "",
      "Source Ledger Difference Fields": "",
      "Sheet Row": null,
      "Sheet Location": "",
      "Sheet Transaction No": null,
      "Sheet Order No": null,
      "Sheet Date": "",
      "Sheet User Details": "",
      "Sheet Location Group": "",
      "Sheet Grand Total (PKR)": null,
      "Sheet Order Type": "",
      "Sheet Order Status": "",
      "DB Legacy Order ID": row.legacyOrderId,
      "DB Order ID": row.databaseOrderId,
      "DB TID": row.tid,
      "DB Branch": row.databaseBranchName,
      "DB Created Date": row.databaseCreatedDate,
      "DB Creator": row.databaseCreatorFullName,
      "DB Subtotal (PKR)": row.databaseSubtotalCents / 100,
      "DB Tax (PKR)": row.databaseTaxCents / 100,
      "DB Grand Total (PKR)": row.databaseTotalCents / 100,
      "DB Refund Amount (PKR)": row.databaseRefundAmountCents == null ? null : row.databaseRefundAmountCents / 100,
      "DB Status": row.databaseStatus,
      "DB Fulfillment Status": row.databaseFulfillmentStatus,
      "DB Business Status": row.databaseBusinessStatus,
      "DB Item Rows": row.databaseItemRows,
    })
  }
  allTrackingRows.sort((left, right) => {
    const leftRow = Number(left["Sheet Row"] ?? Number.MAX_SAFE_INTEGER)
    const rightRow = Number(right["Sheet Row"] ?? Number.MAX_SAFE_INTEGER)
    return leftRow - rightRow || Number(left["DB Legacy Order ID"] ?? Number.MAX_SAFE_INTEGER) - Number(right["DB Legacy Order ID"] ?? Number.MAX_SAFE_INTEGER)
  })

  const actionRows = allTrackingRows.filter((row) => row["Action Required"] === "Yes")
  const sheetOnlyTrackingRows = allTrackingRows.filter((row) => row["Present in Sheet"] === "Yes" && row["Present in Database"] === "No")
  const databaseOnlyTrackingRows = allTrackingRows.filter((row) => row["Present in Sheet"] === "No" && row["Present in Database"] === "Yes")
  const fieldDifferenceRows: Array<Record<string, unknown>> = []
  for (const row of matched) {
    for (const difference of row.sourceDifferences) {
      fieldDifferenceRows.push({
        "Tracking Key": `KE-LEGACY-${row.legacyOrderId}`,
        "Sheet Row": row.sheetRowNumber,
        "DB Legacy Order ID": row.legacyOrderId,
        Location: row.identity.location,
        "Transaction No": row.identity.transactionNo,
        "Order No": row.identity.orderNo,
        Date: row.identity.date,
        "Comparison Layer": "Sheet vs Stored Source Ledger",
        Field: difference.field,
        "Sheet Value": difference.sheet,
        "Database / Ledger Value": difference.liveLedger,
        "Review Required": "No",
      })
    }
    for (const difference of row.databaseDifferences) {
      const substantiveUser = difference.field === "UserDetails"
        && normalizeUserDisplay(difference.sheet) !== normalizeUserDisplay(difference.liveDatabase)
      const businessField = !["UserDetails", "Location"].includes(difference.field)
      fieldDifferenceRows.push({
        "Tracking Key": `KE-LEGACY-${row.legacyOrderId}`,
        "Sheet Row": row.sheetRowNumber,
        "DB Legacy Order ID": row.legacyOrderId,
        Location: row.identity.location,
        "Transaction No": row.identity.transactionNo,
        "Order No": row.identity.orderNo,
        Date: row.identity.date,
        "Comparison Layer": "Sheet vs Materialized Database Order",
        Field: difference.field,
        "Sheet Value": difference.sheet,
        "Database / Ledger Value": difference.liveDatabase,
        "Review Required": businessField || substantiveUser ? "Yes" : "No",
      })
    }
  }

  const overviewRows: Array<Record<string, unknown>> = [
    { Section: "Report", Metric: "Title", Value: "K-Electric Orders Reconciliation Tracker", Guidance: "Use Action Items for follow-up and All Orders for the complete side-by-side population." },
    { Section: "Report", Metric: "Generated", Value: report.generatedAt, Guidance: "Production read-only snapshot; database changes: 0." },
    { Section: "Report", Metric: "Source workbook", Value: basename(INPUT), Guidance: "The source workbook was not modified." },
    { Section: "Population", Metric: "Sheet orders", Value: sheet.length, Guidance: "All source rows." },
    { Section: "Population", Metric: "Live database orders", Value: live.length, Guidance: "K-Electric organization ID 10; all are legacy-imported orders." },
    { Section: "Population", Metric: "Matched on both sides", Value: matched.length, Guidance: "Each match records its deterministic method." },
    { Section: "Population", Metric: "Sheet only", Value: sheetOnly.length, Guidance: "77 cancelled exclusions and 4 refunded orders requiring review." },
    { Section: "Population", Metric: "Database only", Value: liveOnly.length, Guidance: "Six fulfilled/delivered legacy imports absent from the source workbook." },
    { Section: "Action", Metric: "Open action rows", Value: actionRows.length, Guidance: "Unique orders requiring business or attribution review." },
    { Section: "Action", Metric: "Sheet-only refunded", Value: sheetOnly.filter((row) => normalize(row.orderStatus) === "refunded").length, Guidance: "Confirm whether these should be imported or intentionally excluded." },
    { Section: "Action", Metric: "Database-only", Value: liveOnly.length, Guidance: "Confirm why these imported orders are absent from the workbook." },
    { Section: "Action", Metric: "Business-data differences", Value: businessDataMismatchRows.length, Guidance: "Status, order date, or total differs." },
    { Section: "Action", Metric: "Substantive user-attribution differences", Value: substantiveUserAttributionMismatchRows.length, Guidance: "Excludes punctuation and trailing-hyphen display differences." },
    { Section: "Reference", Metric: "Cosmetic user-display differences", Value: cosmeticUserAttributionMismatchRows.length, Guidance: "No action by default." },
    { Section: "Reference", Metric: "Canonical location-label differences", Value: locationLabelMismatchRows.length, Guidance: "Examples include branch aliases such as 1. GSO vs GSO." },
    { Section: "Workflow", Metric: "Review Status values", Value: "Open / In progress / Resolved / Accepted", Guidance: "Update Review Status, Owner, and Follow-up Notes in the tracker." },
  ]

  const workbookOut = XLSX.utils.book_new()
  workbookOut.Props = {
    Title: "K-Electric Orders Reconciliation Tracker",
    Subject: "Order sheet versus live database reconciliation",
    Author: "OneFlowe",
    CreatedDate: new Date(report.generatedAt),
  }
  const moneyColumns = ["Sheet Grand Total (PKR)", "DB Subtotal (PKR)", "DB Tax (PKR)", "DB Grand Total (PKR)", "DB Refund Amount (PKR)"]
  const trackingWidths: Record<string, number> = {
    "Tracking Key": 20,
    "Comparison Category": 36,
    "Action Required": 15,
    "Review Status": 18,
    Owner: 20,
    "Follow-up Notes": 36,
    "Present in Sheet": 15,
    "Present in Database": 18,
    "Match Method": 38,
    "Business Difference Fields": 30,
    "Other DB Difference Fields": 30,
    "Source Ledger Difference Fields": 32,
    "Sheet Row": 11,
    "Sheet Location": 26,
    "Sheet Transaction No": 19,
    "Sheet Order No": 15,
    "Sheet Date": 14,
    "Sheet User Details": 34,
    "Sheet Location Group": 24,
    "Sheet Grand Total (PKR)": 22,
    "Sheet Order Type": 18,
    "Sheet Order Status": 18,
    "DB Legacy Order ID": 18,
    "DB Order ID": 14,
    "DB TID": 20,
    "DB Branch": 26,
    "DB Created Date": 16,
    "DB Creator": 34,
    "DB Subtotal (PKR)": 19,
    "DB Tax (PKR)": 15,
    "DB Grand Total (PKR)": 21,
    "DB Refund Amount (PKR)": 23,
    "DB Status": 16,
    "DB Fulfillment Status": 22,
    "DB Business Status": 20,
    "DB Item Rows": 14,
  }
  addTrackingWorksheet(workbookOut, "Overview", overviewRows, { Section: 14, Metric: 38, Value: 36, Guidance: 72 })
  addTrackingWorksheet(workbookOut, "Action Items", actionRows, trackingWidths, moneyColumns)
  addTrackingWorksheet(workbookOut, "All Orders", allTrackingRows, trackingWidths, moneyColumns)
  addTrackingWorksheet(workbookOut, "Sheet Only", sheetOnlyTrackingRows, trackingWidths, moneyColumns)
  addTrackingWorksheet(workbookOut, "Database Only", databaseOnlyTrackingRows, trackingWidths, moneyColumns)
  addTrackingWorksheet(workbookOut, "Field Differences", fieldDifferenceRows, {
    "Tracking Key": 20,
    "Sheet Row": 11,
    "DB Legacy Order ID": 18,
    Location: 26,
    "Transaction No": 16,
    "Order No": 12,
    Date: 14,
    "Comparison Layer": 38,
    Field: 22,
    "Sheet Value": 38,
    "Database / Ledger Value": 38,
    "Review Required": 17,
  })

  mkdirSync(OUTPUT_DIR, { recursive: true })
  writeFileSync(JSON_OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  writeFileSync(MARKDOWN_OUTPUT, markdown, "utf8")
  writeStyledTrackingWorkbook(workbookOut, EXCEL_OUTPUT)
  console.log(JSON.stringify({
    jsonOutput: JSON_OUTPUT,
    markdownOutput: MARKDOWN_OUTPUT,
    excelOutput: EXCEL_OUTPUT,
    excelSheets: workbookOut.SheetNames,
    excelRows: {
      overview: overviewRows.length,
      actionItems: actionRows.length,
      allOrders: allTrackingRows.length,
      sheetOnly: sheetOnlyTrackingRows.length,
      databaseOnly: databaseOnlyTrackingRows.length,
      fieldDifferences: fieldDifferenceRows.length,
    },
    ...report.summary,
    integrity: report.integrity,
    databaseChanges: 0,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
