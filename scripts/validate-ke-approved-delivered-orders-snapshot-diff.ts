#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import * as XLSX from "xlsx"

type Row = Record<string, any>

const PRE_PATH = resolve("backups/ke-import-state-2026-08-05-pre-approved-delivered-5.json")
const POST_PATH = resolve("backups/ke-import-state-2026-08-05-post-approved-delivered-5.json")
const REMAINING_SOURCE_PATH = resolve("updatedReports/ke-remaining-non-cancelled-orders-21-2026-08-04.xlsx")
const OUTPUT_PATH = resolve("updatedReports/ke-approved-delivered-orders-41-51-53-87-1155-2026-08-05/snapshot-diff.json")
const BATCH_ID = "25563074-24f0-471f-9d6b-32fd06e4d9e4"
const IMPORTED_IDS = [41, 51, 53, 87, 1155]
const REMAINING_IDS = [173, 174, 177, 192, 1168, 1169, 1170, 1171, 1172, 1173, 1184]
const EXPECTED_NEW_ASSIGNMENTS = [
  "133:176",
  "137:196",
  "137:225",
  "137:395",
  "183:281",
  "183:283",
  "183:287",
  "183:308",
  "183:310",
  "183:313",
].sort()

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
  for (const snapshot of [pre, post]) {
    check(snapshot.organizationId === 10
      && snapshot.organization?.[0]?.id === 10
      && snapshot.organization?.[0]?.code === "0001"
      && snapshot.organization?.[0]?.name === "K-Electric"
      && snapshot.organization?.[0]?.status === "active", "K-Electric identity mismatch")
  }

  const unchanged = [
    "organization", "branches", "users", "groups", "refunds", "refundItems",
    "legacyUserMappings", "budgets", "quantityBudgets", "invoiceSequence",
    "crossTenantCounts", "migrations",
  ]
  for (const name of unchanged) check(same(pre[name], post[name]), `${name} changed unexpectedly`)

  for (const name of [
    "orders", "orderItems", "globalProducts", "organizationInventory", "branchInventory",
    "legacyImportBatches", "legacyProductMappings", "legacyOrderImports",
  ]) {
    const afterById = new Map((post[name] as Row[]).map((row) => [String(row.id), row]))
    check((pre[name] as Row[]).every((row) => same(row, afterById.get(String(row.id)))), `${name} pre-existing row changed`)
  }

  const deltas = {
    orders: post.orders.length - pre.orders.length,
    orderItems: post.orderItems.length - pre.orderItems.length,
    refunds: post.refunds.length - pre.refunds.length,
    refundItems: post.refundItems.length - pre.refundItems.length,
    globalProducts: post.globalProducts.length - pre.globalProducts.length,
    organizationInventory: post.organizationInventory.length - pre.organizationInventory.length,
    branchInventory: post.branchInventory.length - pre.branchInventory.length,
    groups: post.groups.length - pre.groups.length,
    users: post.users.length - pre.users.length,
    batches: post.legacyImportBatches.length - pre.legacyImportBatches.length,
    productMappings: post.legacyProductMappings.length - pre.legacyProductMappings.length,
    userMappings: post.legacyUserMappings.length - pre.legacyUserMappings.length,
    imports: post.legacyOrderImports.length - pre.legacyOrderImports.length,
  }
  const expectedDeltas = {
    orders: 5,
    orderItems: 22,
    refunds: 0,
    refundItems: 0,
    globalProducts: 1,
    organizationInventory: 1,
    branchInventory: 10,
    groups: 0,
    users: 0,
    batches: 1,
    productMappings: 1,
    userMappings: 0,
    imports: 5,
  }
  check(same(deltas, expectedDeltas), `Unexpected deltas: ${JSON.stringify(deltas)}`)

  const newRows = (name: string) => {
    const preIds = new Set((pre[name] as Row[]).map((row) => String(row.id)))
    return (post[name] as Row[]).filter((row) => !preIds.has(String(row.id)))
  }
  const newImports = newRows("legacyOrderImports")
  const newOrders = newRows("orders")
  const newItems = newRows("orderItems")
  const newProducts = newRows("globalProducts")
  const newOrgInventory = newRows("organizationInventory")
  const newAssignments = newRows("branchInventory")
  const newMappings = newRows("legacyProductMappings")
  const newBatches = newRows("legacyImportBatches")

  const importedIds = newImports.map((row) => Number(row.legacy_order_id)).sort((a, b) => a - b)
  check(same(importedIds, IMPORTED_IDS), "New import IDs are not exactly the five approved orders")
  check(newImports.every((row) => Number(row.organization_id) === 10
    && row.source_system === "KE_LOGISTICS"
    && String(row.batch_id) === BATCH_ID), "New import ledger tenant/source/batch mismatch")
  const importedOrderIds = new Set(newImports.map((row) => Number(row.order_id)))
  check(newOrders.length === 5
    && newOrders.every((row) => importedOrderIds.has(Number(row.id))
      && Number(row.organization_id) === 10
      && row.status === "FULFILLED"
      && row.fulfillment_status === "DELIVERED"
      && row.payment_status === "UNPAID"
      && Number(row.refund_amount_cents ?? 0) === 0), "New order status/tenant/refund mismatch")
  check(newOrders.reduce((sum, row) => sum + Number(row.subtotal_cents), 0) === 6_590_900
    && newOrders.reduce((sum, row) => sum + Number(row.tax_cents), 0) === 209_052
    && newOrders.reduce((sum, row) => sum + Number(row.total_cents), 0) === 6_799_952, "New order aggregate money mismatch")
  check(newItems.length === 22
    && newItems.every((row) => importedOrderIds.has(Number(row.order_id)) && Number(row.organization_id) === 10)
    && newItems.reduce((sum, row) => sum + Number(row.quantity) * Number(row.price_cents), 0) === 6_590_900, "New order items mismatch")

  const product = newProducts[0]
  const inventory = newOrgInventory[0]
  const mapping = newMappings[0]
  check(newProducts.length === 1
    && product?.name === "Olpers"
    && product?.product_code === "PRD--176"
    && Number(product?.base_price_cents) === 40_000
    && product?.status === "inactive"
    && Number(product?.stock_quantity) === 0
    && product?.deleted_at === null, "New historical-only product mismatch")
  check(newOrgInventory.length === 1
    && Number(inventory?.organization_id) === 10
    && Number(inventory?.global_product_id) === Number(product?.id)
    && inventory?.is_active === false
    && Number(inventory?.custom_price_cents) === 40_000
    && inventory?.deleted_at === null, "New organization inventory mismatch")
  check(newMappings.length === 1
    && Number(mapping?.organization_id) === 10
    && mapping?.source_system === "KE_LOGISTICS"
    && mapping?.normalized_name === "olpers"
    && mapping?.source_name === "Olpers"
    && Number(mapping?.global_product_id) === Number(product?.id)
    && Number(mapping?.organization_inventory_id) === Number(inventory?.id), "New Olpers mapping mismatch")

  const newAssignmentPairs = newAssignments.map((row) => `${row.branch_id}:${row.organization_inventory_id}`).sort()
  check(same(newAssignmentPairs, EXPECTED_NEW_ASSIGNMENTS), "New branch-assignment pairs mismatch")
  check(newAssignments.every((row) => Number(row.organization_id) === 10
    && row.is_active === false
    && row.is_visible === false
    && row.deleted_at === null), "New branch assignments are not inactive/hidden")
  check(newBatches.length === 1
    && String(newBatches[0]?.id) === BATCH_ID
    && newBatches[0]?.status === "COMPLETED"
    && Number(newBatches[0]?.counts?.orders) === 5
    && Number(newBatches[0]?.counts?.products) === 19
    && Number(newBatches[0]?.counts?.newProducts) === 1
    && Number(newBatches[0]?.counts?.newHistoricalUsers) === 0, "New import batch mismatch")

  const excludedImports = (post.legacyOrderImports as Row[]).filter((row) => REMAINING_IDS.includes(Number(row.legacy_order_id)))
  check(excludedImports.length === 0, `Excluded order imports found: ${excludedImports.map((row) => row.legacy_order_id).join(", ")}`)
  const workbook = XLSX.readFile(REMAINING_SOURCE_PATH, { cellDates: false })
  const sourceRows = XLSX.utils.sheet_to_json<Row>(workbook.Sheets["Remaining Orders"], { defval: null, raw: true })
  const importedLegacyIds = new Set((post.legacyOrderImports as Row[]).map((row) => Number(row.legacy_order_id)))
  const remainingIds = sourceRows.map((row) => Number(row["Legacy Order ID"]))
    .filter((id) => !importedLegacyIds.has(id)).sort((a, b) => a - b)
  check(same(remainingIds, REMAINING_IDS), `Updated remaining IDs mismatch: ${remainingIds.join(", ")}`)
  check(post.legacyOrderImports.length === 712 && post.orders.length === 712, "Final imported/order count is not 712")

  const result = {
    generatedAt: new Date().toISOString(),
    status: failures.length === 0 ? "PASS" : "FAILED",
    organizationId: 10,
    batchId: BATCH_ID,
    importedLegacyOrderIds: importedIds,
    remainingLegacyOrderIds: remainingIds,
    remainingCount: remainingIds.length,
    deltas,
    operationalLedgersUnchanged: {
      budgets: same(pre.budgets, post.budgets),
      quantityBudgets: same(pre.quantityBudgets, post.quantityBudgets),
      invoiceSequence: same(pre.invoiceSequence, post.invoiceSequence),
      preExistingProductsAndStock: (pre.globalProducts as Row[]).every((row) => {
        const current = (post.globalProducts as Row[]).find((candidate) => String(candidate.id) === String(row.id))
        return same(row, current)
      }),
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
