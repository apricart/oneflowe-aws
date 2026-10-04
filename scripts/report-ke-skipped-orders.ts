#!/usr/bin/env tsx
/**
 * Excel report of every K-Electric order in a date range that was NOT imported.
 *
 * Companion to `import-ke-orders.ts`. That script deliberately imports only what
 * it can resolve without guessing, and prints counts for everything it leaves
 * behind; this turns those counts into a workbook someone can actually work
 * through — one row per order, with the reason it was left out and, where there
 * is one, the action that would let it in.
 *
 *   npx tsx scripts/report-ke-skipped-orders.ts --start-date=2026-07-01 --end-date=2026-08-25
 *
 * Read-only: it queries the database and the legacy API and writes a file.
 */

import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import * as dotenv from "dotenv"
import * as XLSX from "xlsx"

import {
  KE_ORDERS_ORGANIZATION as ORGANIZATION,
  KE_ORDERS_SOURCE as SOURCE_SYSTEM,
  KE_LOGISTICS_BASE_URL,
  KE_ORDERS_LIST_PATH,
  identityKeyForListRow,
  mapDeliveryStatus,
  orderIdentityKey,
} from "../lib/legacy-import/ke-orders-api"
import {
  legacyStatusText,
  normalizeLegacyProduct,
  normalizeLegacyText,
  type LegacyOrderDetail,
  type LegacyOrderListRow,
} from "../lib/legacy-import/ke-post-cutoff"
import { withoutTrailingDash } from "../lib/user-name-correction"
import { resolveWorkspacePath } from "./lib/resolve-workspace-path"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DETAIL_CONCURRENCY = 6

type Row = Record<string, any>

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function argument(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, init)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as T
    } catch (error) {
      lastError = error
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
  throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length)
  let cursor = 0
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++
      result[index] = await fn(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return result
}

function rupees(cents: number | null | undefined): number | null {
  return cents == null ? null : Math.round(cents) / 100
}

/**
 * ISO day for a value that may already be a Date.
 *
 * `pg` hands back `timestamptz` as a Date, and `String(date).slice(0, 10)`
 * silently yields "Wed Aug 26" — a day with no year, which is worse than no
 * value at all in a report someone files against.
 */
function isoDay(value: unknown): string {
  if (value == null || value === "") return ""
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10)
  }
  return String(value).slice(0, 10)
}

interface Classified {
  outcome: string
  reason: string
  action: string
  legacyOrderId: number
  location: string
  transactionNo: number
  orderNo: number
  date: string
  user: string
  locationGroup: string
  legacyStatus: string
  orderType: string
  totalRupees: number | null
  importedAs: string
  importedOn: string
}

const SHEET_COLUMNS: Array<[keyof Classified, string, number]> = [
  ["legacyOrderId", "Legacy Order ID", 16],
  ["date", "Date", 12],
  ["location", "Location", 26],
  ["locationGroup", "Location Group", 20],
  ["transactionNo", "Transaction No", 15],
  ["orderNo", "Order No", 10],
  ["user", "User Details", 34],
  ["legacyStatus", "Legacy Status", 16],
  ["orderType", "Order Type", 15],
  ["totalRupees", "Grand Total (PKR)", 18],
  ["reason", "Reason", 22],
  ["action", "Action Required", 62],
  ["importedAs", "OneFlowe Order", 18],
  ["importedOn", "Imported On", 12],
]

function addSheet(workbook: XLSX.WorkBook, name: string, records: Classified[], columns = SHEET_COLUMNS) {
  const rows = records.map((record) => {
    const row: Record<string, unknown> = {}
    for (const [key, header] of columns) row[header] = record[key] ?? ""
    return row
  })
  const worksheet = rows.length
    ? XLSX.utils.json_to_sheet(rows)
    : XLSX.utils.aoa_to_sheet([columns.map(([, header]) => header)])

  worksheet["!cols"] = columns.map(([, , width]) => ({ wch: width }))
  worksheet["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" }
  ;(worksheet as any)["!autofilter"] = {
    ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: columns.length - 1 } }),
  }
  const moneyColumn = columns.findIndex(([key]) => key === "totalRupees")
  if (moneyColumn >= 0) {
    for (let index = 1; index <= rows.length; index += 1) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: index, c: moneyColumn })]
      if (cell && cell.t === "n") cell.z = "#,##0.00"
    }
  }
  XLSX.utils.book_append_sheet(workbook, worksheet, name)
}

async function main() {
  const startDate = argument("start-date")
  const endDate = argument("end-date")
  assert(startDate && ISO_DATE.test(startDate), "Required: --start-date=YYYY-MM-DD")
  assert(endDate && ISO_DATE.test(endDate), "Required: --end-date=YYYY-MM-DD")
  const outputPath = resolveWorkspacePath(
    argument("output") ?? `updatedReports/ke-skipped-orders-${startDate}-to-${endDate}.xlsx`)

  const listRows = await fetchJson<LegacyOrderListRow[]>(`${KE_LOGISTICS_BASE_URL}${KE_ORDERS_LIST_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      UserID: 1, StartDate: startDate, EndDate: endDate,
      LocationIDs: null, LocationGroupIDs: null, IsMulti: true,
    }),
  })

  const { pool } = await import("../lib/db-cli")
  try {
    const imported: Row[] = (await pool.query(
      `select li.legacy_order_id, li.created_at as imported_on, o.tid,
              coalesce(li.source_payload->'sourceHeader', li.source_payload->'header') as header
         from legacy_order_imports li
         join orders o on o.id = li.order_id
        where li.organization_id = $1 and li.source_system = $2`,
      [ORGANIZATION.id, SOURCE_SYSTEM])).rows
    const importedById = new Map<number, Row>()
    const importedByIdentity = new Map<string, Row>()
    for (const row of imported) {
      importedById.set(Number(row.legacy_order_id), row)
      if (row.header?.LocationName) {
        importedByIdentity.set(orderIdentityKey({
          locationName: row.header.LocationName,
          transactionNo: row.header.TransactionNo,
          orderNo: row.header.OrderNo,
          date: row.header.OrderCreatedDT ?? row.header.CreatedOn,
        }), row)
      }
    }

    const branchRows: Row[] = (await pool.query(
      `select id, name from branches where organization_id = $1`, [ORGANIZATION.id])).rows
    const branchByName = new Map(branchRows.map((branch) => [normalizeLegacyText(branch.name), branch]))

    const userRows: Row[] = (await pool.query(
      `select u.id, u.full_name, u.branch_id, u.is_active
         from users u join roles r on r.id = u.role_id
        where u.organization_id = $1 and u.deleted_at is null and r.name = 'ORDER_PORTAL'`,
      [ORGANIZATION.id])).rows
    const usersByKey = new Map<string, Row[]>()
    for (const user of userRows) {
      const key = `${user.branch_id}|${normalizeLegacyText(user.full_name)}`
      const bucket = usersByKey.get(key) ?? []
      bucket.push(user)
      usersByKey.set(key, bucket)
    }

    const productRows: Row[] = (await pool.query(
      `select gp.name from organization_inventory oi
         join global_products gp on gp.id = oi.global_product_id
        where oi.organization_id = $1 and oi.deleted_at is null and gp.deleted_at is null`,
      [ORGANIZATION.id])).rows
    const mappingRows: Row[] = (await pool.query(
      `select normalized_name from legacy_product_mappings where organization_id = $1 and source_system = $2`,
      [ORGANIZATION.id, SOURCE_SYSTEM])).rows
    const knownProducts = new Set<string>()
    for (const product of productRows) knownProducts.add(normalizeLegacyProduct(product.name))
    for (const mapping of mappingRows) knownProducts.add(normalizeLegacyProduct(mapping.normalized_name))

    // Details are only needed for live orders that were not imported, i.e. the
    // ones whose exclusion still needs explaining.
    const needsDetail = listRows.filter((row) =>
      Number(row.StatusID) === 2
      && !importedById.has(Number(row.ID))
      && !importedByIdentity.has(identityKeyForListRow(row)))
    const details = await mapConcurrent(needsDetail, DETAIL_CONCURRENCY, (row) =>
      fetchJson<LegacyOrderDetail>(
        `${KE_LOGISTICS_BASE_URL}/api/OrderDetailController/${Number(row.LocationID)}/${Number(row.ID)}`)
        .catch(() => null))
    const detailById = new Map<number, LegacyOrderDetail | null>()
    needsDetail.forEach((row, index) => detailById.set(Number(row.ID), details[index]))

    const classified: Classified[] = listRows.map((row) => {
      const legacyOrderId = Number(row.ID)
      const importedRow = importedById.get(legacyOrderId) ?? importedByIdentity.get(identityKeyForListRow(row))
      const base = {
        legacyOrderId,
        location: String(row.LocationName ?? ""),
        transactionNo: Number(row.TransactionNo),
        orderNo: Number(row.OrderNo),
        date: isoDay(row.OrderCreatedDT),
        user: String(row.UserDetails ?? ""),
        locationGroup: String(row.LocationGroup ?? ""),
        legacyStatus: legacyStatusText(row),
        orderType: String(row.OrderType ?? ""),
        totalRupees: row.GrandTotal == null ? null : rupees(Math.round(Number(row.GrandTotal) * 100)),
        importedAs: importedRow ? String(importedRow.tid) : "",
        importedOn: isoDay(importedRow?.imported_on),
      }

      if (importedRow) {
        return { ...base, outcome: "Imported", reason: "Already in OneFlowe", action: "" }
      }
      if (Number(row.StatusID) === 5) {
        return {
          ...base, outcome: "Skipped", reason: "Cancelled",
          action: "None. A cancelled order has no OneFlowe counterpart and is excluded by design.",
        }
      }
      if (Number(row.StatusID) === 1) {
        return {
          ...base, outcome: "Skipped", reason: "Draft / not submitted",
          action: "None. Unsubmitted basket in the legacy system, carries no grand total.",
        }
      }

      const branch = branchByName.get(normalizeLegacyText(row.LocationName))
      if (!branch) {
        return {
          ...base, outcome: "Needs action", reason: "Branch not found",
          action: `Create or rename a K-Electric branch matching "${row.LocationName}", then re-run the import.`,
        }
      }

      const userName = withoutTrailingDash(String(row.UserDetails ?? "")).trim()
      const candidates = usersByKey.get(`${branch.id}|${normalizeLegacyText(userName)}`) ?? []
      if (candidates.length === 0) {
        return {
          ...base, outcome: "Needs action", reason: "User not found",
          action: `Create an ORDER_PORTAL user named "${userName}" at ${branch.name}, or confirm which existing user to map it to.`,
        }
      }
      if (candidates.length > 1) {
        return {
          ...base, outcome: "Needs action", reason: "User ambiguous",
          action: `${candidates.length} ORDER_PORTAL users named "${userName}" at ${branch.name}. Deactivate or rename the duplicate.`,
        }
      }

      const detail = detailById.get(legacyOrderId)
      if (!detail) {
        return {
          ...base, outcome: "Needs action", reason: "Detail unavailable",
          action: "Legacy detail endpoint did not return this order. Retry; if it persists, raise with K-Electric.",
        }
      }
      const missing = (detail.OrderDetailsList ?? [])
        .filter((line) => Number(line.Quantity ?? 0) > 0)
        .map((line) => String(line.Name ?? "").trim())
        .filter((name) => name && !knownProducts.has(normalizeLegacyProduct(name)))
      if (missing.length > 0) {
        return {
          ...base, outcome: "Needs action", reason: "Product not in catalogue",
          action: `Add to the K-Electric catalogue (or map): ${[...new Set(missing)].join("; ")}`,
        }
      }
      if (!mapDeliveryStatus(Number(row.DeliveryStatus))) {
        return {
          ...base, outcome: "Needs action", reason: "Unsupported status",
          action: `Legacy DeliveryStatus ${String(row.DeliveryStatus)} has no OneFlowe equivalent yet.`,
        }
      }
      return {
        ...base, outcome: "Needs action", reason: "Not yet imported",
        action: "Resolvable — re-run import-ke-orders.ts to bring this in.",
      }
    })

    const needsAction = classified.filter((row) => row.outcome === "Needs action")
    const cancelled = classified.filter((row) => row.reason === "Cancelled")
    const drafts = classified.filter((row) => row.reason === "Draft / not submitted")
    const importedRows = classified.filter((row) => row.outcome === "Imported")
    const skipped = classified.filter((row) => row.outcome !== "Imported")

    const total = (records: Classified[]) =>
      records.reduce((sum, record) => sum + (record.totalRupees ?? 0), 0)

    const workbook = XLSX.utils.book_new()
    const summary = [
      ["K-Electric orders not imported", ""],
      ["Range", `${startDate} to ${endDate}`],
      ["Generated", new Date().toISOString().slice(0, 19).replace("T", " ")],
      ["", ""],
      ["Category", "Orders", "Value (PKR)"],
      ["Needs action", needsAction.length, total(needsAction)],
      ["Cancelled in legacy system", cancelled.length, total(cancelled)],
      ["Draft / not submitted", drafts.length, total(drafts)],
      ["", "", ""],
      ["Total not imported", skipped.length, total(skipped)],
      ["Already imported", importedRows.length, total(importedRows)],
      ["Orders in range", classified.length, total(classified)],
    ]
    const summarySheet = XLSX.utils.aoa_to_sheet(summary)
    summarySheet["!cols"] = [{ wch: 32 }, { wch: 12 }, { wch: 18 }]
    for (let index = 5; index < summary.length; index += 1) {
      const cell = summarySheet[XLSX.utils.encode_cell({ r: index, c: 2 })]
      if (cell && cell.t === "n") cell.z = "#,##0.00"
    }
    XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary")

    addSheet(workbook, "Needs Action", needsAction)
    addSheet(workbook, "Cancelled", cancelled)
    addSheet(workbook, "Drafts", drafts)
    addSheet(workbook, "Already Imported", importedRows)

    mkdirSync(dirname(outputPath), { recursive: true })
    XLSX.writeFile(workbook, outputPath, { bookType: "xlsx", compression: true })

    console.log(JSON.stringify({
      output: outputPath,
      range: { startDate, endDate },
      ordersInRange: classified.length,
      notImported: {
        total: skipped.length,
        needsAction: needsAction.length,
        cancelled: cancelled.length,
        drafts: drafts.length,
      },
      alreadyImported: importedRows.length,
      needsActionByReason: needsAction.reduce<Record<string, number>>((counts, row) => {
        counts[row.reason] = (counts[row.reason] ?? 0) + 1
        return counts
      }, {}),
    }, null, 2))
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
