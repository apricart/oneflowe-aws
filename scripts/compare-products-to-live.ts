#!/usr/bin/env tsx
/**
 * Compare an exported product catalogue CSV against the database currently
 * configured in DATABASE_URL, and report what is present, what differs, and
 * what is absent on either side.
 *
 * Read-only: one read-only transaction, SELECT statements only. Safe to point
 * at production.
 *
 * The join key is the **normalized product name**, not `product_code`. Codes
 * are assigned per database (a KE-synced database numbers them `KE-<legacy
 * id>`, a hand-curated one `PRD--<n>`), so they do not survive a comparison
 * between two separately populated databases. Category *ids* are per-database
 * for the same reason, so categories are compared by name.
 *
 * Usage:
 *   tsx scripts/compare-products-to-live.ts
 *   tsx scripts/compare-products-to-live.ts --file=deliverables/products-csv/catalogue.csv
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { parse } from "csv-parse/sync"

import { closePool, pool } from "../lib/db-cli"
import { createCsv } from "../lib/spreadsheet"

const DEFAULT_FILE = "deliverables/products-csv/catalogue.csv"
const DEFAULT_REPORT = "deliverables/products-csv/comparison-to-live.csv"

type LiveRow = {
  id: number
  product_code: string
  name: string
  base_price_cents: number
  status: string
  unit: string
  stock_quantity: string
  deleted_at: string | null
  category_name: string | null
}

type Verdict = "PRESENT_IDENTICAL" | "PRESENT_DIFFERS" | "MISSING_IN_LIVE" | "ONLY_IN_LIVE"

function argument(name: string): string | undefined {
  const flag = `--${name}=`
  const inline = process.argv.find((value) => value.startsWith(flag))
  return inline ? inline.slice(flag.length) : undefined
}

/** Names carry stray tabs and double spaces on both sides; fold them. */
function normalizeName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

function sameNumber(left: string, right: string | number): boolean {
  const a = Number(left)
  const b = Number(right)
  return Number.isFinite(a) && Number.isFinite(b) ? a === b : String(left) === String(right)
}

async function main(): Promise<void> {
  const filePath = resolve(process.cwd(), argument("file") || DEFAULT_FILE)
  const reportPath = resolve(process.cwd(), argument("report") || DEFAULT_REPORT)

  const fileRows = parse(readFileSync(filePath, "utf8"), {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[]

  const client = await pool.connect()
  let liveRows: LiveRow[]
  try {
    await client.query("BEGIN TRANSACTION READ ONLY")
    liveRows = (
      await client.query<LiveRow>(
        `SELECT gp.id, gp.product_code, gp.name, gp.base_price_cents, gp.status, gp.unit,
                gp.stock_quantity::text AS stock_quantity, gp.deleted_at::text AS deleted_at,
                c.name AS category_name
           FROM global_products gp
           LEFT JOIN categories c ON c.id = gp.category_id
          ORDER BY gp.id`,
      )
    ).rows
    await client.query("COMMIT")
  } finally {
    client.release()
  }

  const liveByName = new Map<string, LiveRow>()
  for (const row of liveRows) liveByName.set(normalizeName(row.name), row)

  const matchedLiveIds = new Set<number>()
  const report: (string | number)[][] = []
  const counts: Record<Verdict, number> = {
    PRESENT_IDENTICAL: 0,
    PRESENT_DIFFERS: 0,
    MISSING_IN_LIVE: 0,
    ONLY_IN_LIVE: 0,
  }

  for (const row of fileRows) {
    const live = liveByName.get(normalizeName(row.name))
    if (!live) {
      counts.MISSING_IN_LIVE += 1
      report.push([
        "MISSING_IN_LIVE", row.name, row.product_code, "", row.base_price_cents, "",
        row.status, "", row.category_name ?? "", "", row.stock_quantity, "", "",
      ])
      continue
    }

    matchedLiveIds.add(live.id)
    const differences: string[] = []
    if (!sameNumber(row.base_price_cents, live.base_price_cents)) differences.push("base_price_cents")
    if ((row.status ?? "").trim() !== live.status) differences.push("status")
    if (normalizeName(row.category_name) !== normalizeName(live.category_name)) differences.push("category")
    if ((row.unit ?? "").trim() !== live.unit) differences.push("unit")
    if (!sameNumber(row.stock_quantity, live.stock_quantity)) differences.push("stock_quantity")
    if (live.deleted_at) differences.push("deleted_in_live")

    const verdict: Verdict = differences.length === 0 ? "PRESENT_IDENTICAL" : "PRESENT_DIFFERS"
    counts[verdict] += 1
    report.push([
      verdict, row.name, row.product_code, live.product_code,
      row.base_price_cents, live.base_price_cents, row.status, live.status,
      row.category_name ?? "", live.category_name ?? "",
      row.stock_quantity, live.stock_quantity, differences.join(" "),
    ])
  }

  for (const live of liveRows) {
    if (matchedLiveIds.has(live.id)) continue
    counts.ONLY_IN_LIVE += 1
    report.push([
      "ONLY_IN_LIVE", live.name, "", live.product_code, "", live.base_price_cents,
      "", live.status, "", live.category_name ?? "", "", live.stock_quantity,
      live.deleted_at ? "deleted_in_live" : "",
    ])
  }

  writeFileSync(
    reportPath,
    createCsv(
      [
        "verdict", "name", "file_product_code", "live_product_code",
        "file_base_price_cents", "live_base_price_cents", "file_status", "live_status",
        "file_category", "live_category", "file_stock_quantity", "live_stock_quantity",
        "differences",
      ],
      report,
    ),
    { encoding: "utf8", mode: 0o600 },
  )

  console.log(`File:    ${filePath}  (${fileRows.length} products)`)
  console.log(`Live DB: global_products  (${liveRows.length} products)`)
  console.log("Joined on normalized product name; product codes are per-database.\n")
  console.log(`  PRESENT_IDENTICAL  ${String(counts.PRESENT_IDENTICAL).padStart(5)}`)
  console.log(`  PRESENT_DIFFERS    ${String(counts.PRESENT_DIFFERS).padStart(5)}`)
  console.log(`  MISSING_IN_LIVE    ${String(counts.MISSING_IN_LIVE).padStart(5)}`)
  console.log(`  ONLY_IN_LIVE       ${String(counts.ONLY_IN_LIVE).padStart(5)}`)
  console.log(`\nReport: ${reportPath}`)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => closePool())
