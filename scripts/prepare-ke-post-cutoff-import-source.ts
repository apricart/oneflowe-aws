#!/usr/bin/env tsx
/**
 * Captures an immutable, self-validating source snapshot for K-Electric orders
 * created strictly after 2026-07-10. This script is read-only with respect to
 * both applications; it writes JSON evidence only beneath --output-root.
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { basename, resolve } from "path"
import * as XLSX from "xlsx"
import {
  KE_POST_CUTOFF_DATE,
  KE_POST_CUTOFF_EXPECTED,
  canonicalJson,
  legacyStatusText,
  normalizeLegacyText,
  preparePostCutoffOrders,
  sha256,
  validateBudgetRows,
  validateExpectedPostCutoffTotals,
  type LegacyBudgetRow,
  type LegacyOrderDetail,
  type LegacyOrderListRow,
} from "../lib/legacy-import/ke-post-cutoff"

interface SheetRow {
  Location: string
  TransactionNo: number
  OrderNo: number
  Date: Date | string | number
  UserDetails: string
  LocationGroup: string
  GrandTotal?: number | null
  OrderType: string
  "Order Status": string
}

interface Options {
  xlsPath: string
  budgetPath: string
  outputRoot: string
  startDate: string
  endDate: string
}

function parseOptions(): Options {
  const values = new Map<string, string>()
  for (const argument of process.argv.slice(2)) {
    const match = argument.match(/^--([^=]+)=(.*)$/)
    if (!match) throw new Error(`Unknown argument ${argument}; arguments must use --name=value`)
    values.set(match[1], match[2])
  }
  return {
    xlsPath: resolve(values.get("xls") ?? "C:/Users/ESHOP/Downloads/Orders (16).xls"),
    budgetPath: resolve(values.get("budget") ?? "C:/Users/ESHOP/.codex/attachments/9d1263ff-38f0-4330-8654-5a9959996959/pasted-text.txt"),
    outputRoot: resolve(values.get("output-root") ?? "updatedReports/ke-post-cutoff-2026-08-07"),
    startDate: values.get("start-date") ?? KE_POST_CUTOFF_DATE,
    endDate: values.get("end-date") ?? "2026-08-06",
  }
}

function toDay(value: SheetRow["Date"]): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid sheet date ${String(value)}`)
  return date.toISOString().slice(0, 10)
}

function moneyKey(value: unknown): string {
  if (value == null || value === "") return "null"
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`Invalid sheet/list total ${String(value)}`)
  return String(Math.round(number * 100))
}

function sheetKey(row: SheetRow): string {
  const status = normalizeLegacyText(row["Order Status"])
  const total = moneyKey(row.GrandTotal)
  return [
    normalizeLegacyText(row.Location),
    Number(row.TransactionNo),
    Number(row.OrderNo),
    toDay(row.Date),
    normalizeLegacyText(row.UserDetails),
    normalizeLegacyText(row.LocationGroup),
    status === "cancelled" ? "cancelled-total-ignored" : status === "order placed" && ["null", "0"].includes(total) ? "missing-total" : total,
    normalizeLegacyText(row.OrderType),
    status,
  ].join("|")
}

function listKey(row: LegacyOrderListRow): string {
  const status = normalizeLegacyText(legacyStatusText(row))
  const total = moneyKey(row.GrandTotal)
  return [
    normalizeLegacyText(row.LocationName),
    Number(row.TransactionNo),
    Number(row.OrderNo),
    String(row.OrderCreatedDT).slice(0, 10),
    normalizeLegacyText(row.UserDetails),
    normalizeLegacyText(row.LocationGroup),
    status === "cancelled" ? "cancelled-total-ignored" : status === "order placed" && ["null", "0"].includes(total) ? "missing-total" : total,
    normalizeLegacyText(row.OrderType),
    status,
  ].join("|")
}

function multiset(values: string[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1)
  return result
}

function assertSameMultiset(left: string[], right: string[], context: string): void {
  const a = multiset(left)
  const b = multiset(right)
  const keys = new Set([...a.keys(), ...b.keys()])
  const differences = [...keys].filter((key) => a.get(key) !== b.get(key))
  if (differences.length) {
    throw new Error(`${context}: ${differences.length} row signature(s) differ; first=${differences[0]}`)
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return await response.json() as T
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, fn: (value: T) => Promise<R>): Promise<R[]> {
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

function writeJson(path: string, value: unknown): { bytes: number; sha256: string } {
  const body = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(path, body, "utf8")
  return { bytes: Buffer.byteLength(body), sha256: sha256(body) }
}

async function main() {
  const options = parseOptions()
  if (options.startDate !== KE_POST_CUTOFF_DATE) {
    throw new Error(`Safety gate: start-date must remain ${KE_POST_CUTOFF_DATE}`)
  }
  const xlsBytes = readFileSync(options.xlsPath)
  const budgetBytes = readFileSync(options.budgetPath)
  const workbook = XLSX.read(xlsBytes, { type: "buffer", cellDates: true })
  if (workbook.SheetNames.length !== 1) throw new Error("Expected exactly one worksheet")
  const sheetRows = XLSX.utils.sheet_to_json<SheetRow>(workbook.Sheets[workbook.SheetNames[0]], { defval: null })
  if (sheetRows.length !== KE_POST_CUTOFF_EXPECTED.sheetRows) {
    throw new Error(`Expected ${KE_POST_CUTOFF_EXPECTED.sheetRows} spreadsheet rows, got ${sheetRows.length}`)
  }
  const budgetRows = JSON.parse(budgetBytes.toString("utf8")) as LegacyBudgetRow[]
  validateBudgetRows(budgetRows)

  const listUrl = "https://logistics.oneflowe.com/api/OrderController/GetFilterOrdersMultiLocations"
  const listRows = await fetchJson<LegacyOrderListRow[]>(listUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      UserID: 1,
      StartDate: options.startDate,
      EndDate: options.endDate,
      LocationIDs: null,
      LocationGroupIDs: null,
      IsMulti: true,
    }),
  })
  assertSameMultiset(sheetRows.map(sheetKey), listRows.map(listKey), "Spreadsheet/API list reconciliation")
  const afterCutoffRows = listRows.filter((row) => String(row.OrderCreatedDT).slice(0, 10) > KE_POST_CUTOFF_DATE)
  if (afterCutoffRows.length !== KE_POST_CUTOFF_EXPECTED.afterCutoffRows) {
    throw new Error(`Expected ${KE_POST_CUTOFF_EXPECTED.afterCutoffRows} API rows after cutoff, got ${afterCutoffRows.length}`)
  }
  const importableHeaders = afterCutoffRows.filter((row) => Number(row.StatusID) !== 5)
  const details = await mapConcurrent(importableHeaders, 8, async (row) => {
    const url = `https://logistics.oneflowe.com/api/OrderDetailController/${Number(row.LocationID)}/${Number(row.ID)}`
    return await fetchJson<LegacyOrderDetail>(url)
  })
  const { prepared, cancelledIds, zeroValueLineIds } = preparePostCutoffOrders(listRows, details)
  validateExpectedPostCutoffTotals(prepared, cancelledIds)
  if (zeroValueLineIds.length !== 3) throw new Error(`Expected three zero-value source lines, got ${zeroValueLineIds.length}`)

  mkdirSync(options.outputRoot, { recursive: true })
  const files: Record<string, { path: string; bytes: number; sha256: string }> = {}
  for (const [name, value] of [
    ["sheet-rows.json", sheetRows],
    ["legacy-order-list.json", listRows],
    ["legacy-order-details.json", details],
    ["budget-source.json", budgetRows],
  ] as const) {
    const metadata = writeJson(resolve(options.outputRoot, name), value)
    files[name] = { path: name, ...metadata }
  }
  const sourceManifest = {
    schemaVersion: 1,
    sourceSystem: "KE_LOGISTICS",
    organization: { id: 10, code: "0001", name: "K-Electric" },
    cutoffPolicy: `OrderCreatedDT date must be strictly later than ${KE_POST_CUTOFF_DATE}`,
    requestedRange: { startDate: options.startDate, endDate: options.endDate },
    sourceFiles: {
      spreadsheet: { name: basename(options.xlsPath), bytes: xlsBytes.length, sha256: sha256(xlsBytes) },
      budgetAttachment: { name: basename(options.budgetPath), bytes: budgetBytes.length, sha256: sha256(budgetBytes) },
    },
    api: { listUrl, detailUrlTemplate: "https://logistics.oneflowe.com/api/OrderDetailController/{LocationID}/{OrderID}" },
    counts: {
      spreadsheetRows: sheetRows.length,
      apiRows: listRows.length,
      afterCutoffRows: afterCutoffRows.length,
      cancelledSkipped: cancelledIds.length,
      importable: prepared.length,
      approvedOperational: prepared.filter((order) => order.status === "APPROVED").length,
      fulfilledHistorical: prepared.filter((order) => order.status === "FULFILLED").length,
      itemRowsImported: prepared.reduce((sum, order) => sum + order.lines.length, 0),
      zeroValueRowsOmitted: zeroValueLineIds.length,
    },
    totalsCents: {
      approvedHeld: prepared.filter((order) => order.status === "APPROVED").reduce((sum, order) => sum + order.totalCents, 0),
      fulfilled: prepared.filter((order) => order.status === "FULFILLED").reduce((sum, order) => sum + order.totalCents, 0),
      all: prepared.reduce((sum, order) => sum + order.totalCents, 0),
    },
    policies: {
      cancelled: "SKIP",
      partial: "FULFILLED_DELIVERED",
      order1327: "FULFILLED_DELIVERED_ITEM_SUBTOTAL_ZERO_TAX_AND_CHARGES",
      zeroQuantityZeroValueLines: "OMIT",
      approvedOrders: "OPERATIONAL_WITH_TOKEN_PROVENANCE_AND_MONEY_BUDGET_HOLD",
      stock: "UNCHANGED_LEGACY_ALREADY_CONSUMED",
      quantityBudgets: "UNCHANGED",
      sourceUsedBudget: "EVIDENCE_ONLY_NOT_IMPORTED_AS_SPENT",
    },
    cancelledIds,
    zeroValueLineIds,
    files,
  }
  const digest = sha256(canonicalJson(sourceManifest))
  writeJson(resolve(options.outputRoot, "source-manifest.json"), { ...sourceManifest, digest })
  console.log(JSON.stringify({ outputRoot: options.outputRoot, digest, counts: sourceManifest.counts, totalsCents: sourceManifest.totalsCents }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
