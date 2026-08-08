#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

type Row = Record<string, any>

const PRE_PATH = resolve("backups/ke-import-state-2026-08-05-pre-order-415.json")
const POST_PATH = resolve("backups/ke-import-state-2026-08-05-post-order-415.json")
const OUTPUT_PATH = resolve("updatedReports/ke-order-415-missing-values-zero-2026-08-05/snapshot-diff.json")

function json(path: string): any { return JSON.parse(readFileSync(path, "utf8")) }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function checksum(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex") }
function sidecar(path: string): string { return readFileSync(`${path}.sha256`, "utf8").trim().split(/\s+/)[0] }

function main() {
  const pre = json(PRE_PATH)
  const post = json(POST_PATH)
  const failures: string[] = []
  const check = (condition: unknown, message: string) => { if (!condition) failures.push(message) }
  check(checksum(PRE_PATH) === sidecar(PRE_PATH), "Pre-snapshot checksum mismatch")
  check(checksum(POST_PATH) === sidecar(POST_PATH), "Post-snapshot checksum mismatch")
  for (const snapshot of [pre, post]) check(snapshot.organization?.[0]?.id === 10 && snapshot.organization?.[0]?.code === "0001" && snapshot.organization?.[0]?.name === "K-Electric" && snapshot.organization?.[0]?.status === "active", "K-Electric identity mismatch")

  const unchanged = [
    "organization", "branches", "users", "globalProducts", "organizationInventory", "branchInventory",
    "groups", "legacyProductMappings", "legacyUserMappings", "budgets", "quantityBudgets",
    "invoiceSequence", "refunds", "refundItems", "crossTenantCounts", "migrations",
  ]
  for (const name of unchanged) check(same(pre[name], post[name]), `${name} changed unexpectedly`)
  for (const name of ["orders", "orderItems", "legacyImportBatches", "legacyOrderImports"]) {
    const afterById = new Map((post[name] as Row[]).map((row) => [String(row.id), row]))
    check((pre[name] as Row[]).every((row) => same(row, afterById.get(String(row.id)))), `${name} pre-existing row changed`)
  }

  const deltas = {
    orders: post.orders.length - pre.orders.length,
    orderItems: post.orderItems.length - pre.orderItems.length,
    batches: post.legacyImportBatches.length - pre.legacyImportBatches.length,
    imports: post.legacyOrderImports.length - pre.legacyOrderImports.length,
    branchInventory: post.branchInventory.length - pre.branchInventory.length,
    refunds: post.refunds.length - pre.refunds.length,
    refundItems: post.refundItems.length - pre.refundItems.length,
    users: post.users.length - pre.users.length,
    userMappings: post.legacyUserMappings.length - pre.legacyUserMappings.length,
    products: post.globalProducts.length - pre.globalProducts.length,
    organizationInventory: post.organizationInventory.length - pre.organizationInventory.length,
  }
  const expectedDeltas = {
    orders: 1, orderItems: 2, batches: 1, imports: 1, branchInventory: 0,
    refunds: 0, refundItems: 0, users: 0, userMappings: 0, products: 0, organizationInventory: 0,
  }
  check(same(deltas, expectedDeltas), `Unexpected deltas: ${JSON.stringify(deltas)}`)

  const preImportIds = new Set((pre.legacyOrderImports as Row[]).map((row) => String(row.id)))
  const newImports = (post.legacyOrderImports as Row[]).filter((row) => !preImportIds.has(String(row.id)))
  check(newImports.length === 1 && Number(newImports[0]?.legacy_order_id) === 415 && Number(newImports[0]?.organization_id) === 10 && newImports[0]?.source_system === "KE_LOGISTICS", "New import ledger row mismatch")
  const importedOrder = newImports[0] ? (post.orders as Row[]).find((row) => Number(row.id) === Number(newImports[0].order_id)) : undefined
  check(importedOrder?.tid === "KE-LEGACY-415" && importedOrder?.status === "FULFILLED" && importedOrder?.fulfillment_status === "DELIVERED", "Imported order identity/status mismatch")
  check(Number(importedOrder?.subtotal_cents) === 822_000 && Number(importedOrder?.tax_cents) === 0 && Number(importedOrder?.total_cents) === 822_000, "Imported order money mismatch")
  const importedItems = importedOrder ? (post.orderItems as Row[]).filter((row) => Number(row.order_id) === Number(importedOrder.id)) : []
  check(importedItems.length === 2, `Expected two imported items; found ${importedItems.length}`)
  check(importedItems.reduce((sum, row) => sum + Math.round(Number(row.quantity) * Number(row.price_cents)), 0) === 822_000, "Imported item subtotal mismatch")

  const newBatchIds = new Set(newImports.map((row) => String(row.batch_id)))
  const newBatches = (post.legacyImportBatches as Row[]).filter((row) => newBatchIds.has(String(row.id)))
  check(newBatches.length === 1 && newBatches[0]?.status === "COMPLETED" && Number(newBatches[0]?.counts?.orders) === 1 && Number(newBatches[0]?.counts?.newProducts) === 0 && Number(newBatches[0]?.counts?.newHistoricalUsers) === 0, "New batch mismatch")
  check(post.legacyOrderImports.length === 706 && post.orders.length === 706, "Final imported/order count is not 706")

  const result = {
    generatedAt: new Date().toISOString(),
    status: failures.length === 0 ? "PASS" : "FAILED",
    organizationId: 10,
    importedLegacyOrderIds: newImports.map((row) => Number(row.legacy_order_id)),
    batchId: newBatches[0]?.id ?? null,
    deltas,
    operationalLedgersUnchanged: {
      budgets: same(pre.budgets, post.budgets),
      quantityBudgets: same(pre.quantityBudgets, post.quantityBudgets),
      invoiceSequence: same(pre.invoiceSequence, post.invoiceSequence),
      globalProductsAndStock: same(pre.globalProducts, post.globalProducts),
      crossTenantOrders: same(pre.crossTenantCounts, post.crossTenantCounts),
    },
    snapshotChecksums: { before: checksum(PRE_PATH), after: checksum(POST_PATH) },
    failures,
  }
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
  console.log(JSON.stringify({ output: OUTPUT_PATH, ...result }, null, 2))
  if (failures.length > 0) process.exitCode = 1
}

main()
