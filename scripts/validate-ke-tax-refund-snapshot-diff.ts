#!/usr/bin/env tsx

/** Offline before/after safety validation for the K-Electric 43/44 import. */

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

type Row = Record<string, any>

const ORG_ID = 10
const BATCH_ID = "4932ff6a-5e72-4941-98f2-121be0abf0f6"
const MIGRATION_CREATED_AT = "1785902400000"

function arg(name: string, fallback: string): string {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(path))).digest("hex")
}

function sidecarChecksum(path: string): string {
  return readFileSync(resolve(`${path}.sha256`), "utf8").trim().split(/\s+/)[0].toLowerCase()
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function byId(rows: Row[]): Map<string, Row> {
  return new Map(rows.map((row) => [String(row.id), row]))
}

function main() {
  const beforePath = arg("--before", "backups/ke-tax-refund-pre-migration-2026-08-05.json")
  const afterPath = arg("--after", "backups/ke-tax-refund-post-import-2026-08-05.json")
  const migrationPath = arg("--migration", "drizzle/20260805090000_add_refund_tax_cents.sql")
  const outputPath = resolve(arg("--output", "updatedReports/ke-tax-refund-orders-snapshot-diff-2026-08-05.json"))
  const before = JSON.parse(readFileSync(resolve(beforePath), "utf8")) as Record<string, any>
  const after = JSON.parse(readFileSync(resolve(afterPath), "utf8")) as Record<string, any>
  const failures: string[] = []
  const check = (condition: boolean, message: string) => {
    if (!condition) failures.push(message)
  }

  const beforeChecksum = sha256File(beforePath)
  const afterChecksum = sha256File(afterPath)
  check(beforeChecksum === sidecarChecksum(beforePath), "Before snapshot checksum mismatch")
  check(afterChecksum === sidecarChecksum(afterPath), "After snapshot checksum mismatch")
  check(before.organizationId === ORG_ID && after.organizationId === ORG_ID, "Snapshot organization mismatch")

  const unchangedCollections = [
    "organization", "branches", "users", "globalProducts", "organizationInventory",
    "branchInventory", "groups", "legacyProductMappings", "legacyUserMappings",
    "budgets", "quantityBudgets", "invoiceSequence", "crossTenantCounts",
  ]
  for (const collection of unchangedCollections) {
    check(same(before[collection], after[collection]), `${collection} changed unexpectedly`)
  }

  for (const collection of ["orders", "orderItems", "refunds", "refundItems", "legacyImportBatches", "legacyOrderImports"]) {
    const afterRows = byId(after[collection] as Row[])
    const changedExisting = (before[collection] as Row[]).filter((row) => !same(row, afterRows.get(String(row.id))))
    check(changedExisting.length === 0, `${collection} changed ${changedExisting.length} pre-existing rows`)
  }

  const deltas = {
    orders: after.orders.length - before.orders.length,
    orderItems: after.orderItems.length - before.orderItems.length,
    refunds: after.refunds.length - before.refunds.length,
    refundItems: after.refundItems.length - before.refundItems.length,
    legacyImportBatches: after.legacyImportBatches.length - before.legacyImportBatches.length,
    legacyOrderImports: after.legacyOrderImports.length - before.legacyOrderImports.length,
    migrations: after.migrations.length - before.migrations.length,
  }
  check(deltas.orders === 2, `Order delta is ${deltas.orders}, expected 2`)
  check(deltas.orderItems === 4, `Order-item delta is ${deltas.orderItems}, expected 4`)
  check(deltas.refunds === 2, `Refund delta is ${deltas.refunds}, expected 2`)
  check(deltas.refundItems === 3, `Refund-item delta is ${deltas.refundItems}, expected 3`)
  check(deltas.legacyImportBatches === 1, `Batch delta is ${deltas.legacyImportBatches}, expected 1`)
  check(deltas.legacyOrderImports === 2, `Import-ledger delta is ${deltas.legacyOrderImports}, expected 2`)
  check(deltas.migrations === 1, `Migration delta is ${deltas.migrations}, expected 1`)

  const batch = (after.legacyImportBatches as Row[]).find((row) => row.id === BATCH_ID)
  check(batch?.organization_id === ORG_ID && batch?.status === "COMPLETED", "Committed batch identity/status mismatch")
  check(Number(batch?.counts?.newBranchAssignments) === 0 && Number(batch?.counts?.newUserMappings) === 0, "Batch created mappings unexpectedly")

  const imports = (after.legacyOrderImports as Row[]).filter((row) => row.batch_id === BATCH_ID)
  const importedLegacyIds = imports.map((row) => Number(row.legacy_order_id)).sort((a, b) => a - b)
  check(same(importedLegacyIds, [43, 44]), "Batch legacy IDs are not exactly 43 and 44")
  const importedOrderIds = new Set(imports.map((row) => Number(row.order_id)))
  const importedOrders = (after.orders as Row[]).filter((row) => importedOrderIds.has(Number(row.id)))
  const importedRefunds = (after.refunds as Row[]).filter((row) => importedOrderIds.has(Number(row.order_id)))
  check(importedOrders.length === 2 && importedRefunds.length === 2, "Imported order/refund rows are incomplete")
  check(importedOrders.reduce((sum, row) => sum + Number(row.total_cents), 0) === 104_902, "Imported order total mismatch")
  check(importedOrders.reduce((sum, row) => sum + Number(row.refund_amount_cents), 0) === 99_238, "Imported gross refund mismatch")
  check(importedRefunds.reduce((sum, row) => sum + Number(row.tax_refund_cents), 0) === 15_138, "Imported tax refund mismatch")

  const migrationHash = sha256File(migrationPath)
  const migrationRows = (after.migrations as Row[]).filter((row) => String(row.created_at) === MIGRATION_CREATED_AT)
  check(migrationRows.length === 1 && migrationRows[0].hash === migrationHash, "Applied migration hash/timestamp mismatch")

  const result = {
    generatedAt: new Date().toISOString(),
    status: failures.length === 0 ? "PASS" : "FAILED",
    organizationId: ORG_ID,
    batchId: BATCH_ID,
    snapshotChecksums: { before: beforeChecksum, after: afterChecksum },
    migrationHash,
    deltas,
    importedLegacyIds,
    unchangedCollections,
    failures,
  }
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
  console.log(JSON.stringify({ ...result, output: outputPath }, null, 2))
  if (failures.length > 0) process.exitCode = 1
}

main()
