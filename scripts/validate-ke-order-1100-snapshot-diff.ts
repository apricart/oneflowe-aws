#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

type Row = Record<string, any>

const PRE_PATH = resolve("backups/ke-import-state-2026-08-05-pre-order-1100.json")
const POST_PATH = resolve("backups/ke-import-state-2026-08-05-post-order-1100.json")
const OUTPUT_PATH = resolve("updatedReports/ke-order-1100-millac-mapping-2026-08-05/snapshot-diff.json")
const BATCH_ID = "67eda412-2efc-4c6a-b298-aea863e968c2"
const EXPECTED_BRANCH_INVENTORY_IDS = [175, 201, 205, 206, 208, 209, 210, 211, 216, 225, 227, 245, 248, 269, 270, 275]

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
    "organization", "branches", "users", "globalProducts", "organizationInventory",
    "groups", "legacyProductMappings", "budgets", "quantityBudgets",
    "invoiceSequence", "crossTenantCounts", "migrations",
  ]
  for (const name of unchanged) check(same(pre[name], post[name]), `${name} changed unexpectedly`)

  for (const name of ["orders", "orderItems", "refunds", "refundItems", "branchInventory", "legacyImportBatches", "legacyUserMappings", "legacyOrderImports"]) {
    const afterById = new Map((post[name] as Row[]).map((row) => [String(row.id), row]))
    check((pre[name] as Row[]).every((row) => same(row, afterById.get(String(row.id)))), `${name} pre-existing row changed`)
  }

  const deltas = {
    orders: post.orders.length - pre.orders.length,
    orderItems: post.orderItems.length - pre.orderItems.length,
    refunds: post.refunds.length - pre.refunds.length,
    refundItems: post.refundItems.length - pre.refundItems.length,
    branchInventory: post.branchInventory.length - pre.branchInventory.length,
    batches: post.legacyImportBatches.length - pre.legacyImportBatches.length,
    userMappings: post.legacyUserMappings.length - pre.legacyUserMappings.length,
    imports: post.legacyOrderImports.length - pre.legacyOrderImports.length,
    users: post.users.length - pre.users.length,
    globalProducts: post.globalProducts.length - pre.globalProducts.length,
    organizationInventory: post.organizationInventory.length - pre.organizationInventory.length,
  }
  const expectedDeltas = {
    orders: 1,
    orderItems: 16,
    refunds: 1,
    refundItems: 1,
    branchInventory: 16,
    batches: 1,
    userMappings: 1,
    imports: 1,
    users: 0,
    globalProducts: 0,
    organizationInventory: 0,
  }
  check(same(deltas, expectedDeltas), `Unexpected deltas: ${JSON.stringify(deltas)}`)

  const preIds = (name: string) => new Set((pre[name] as Row[]).map((row) => String(row.id)))
  const newRows = (name: string) => (post[name] as Row[]).filter((row) => !preIds(name).has(String(row.id)))
  const newImports = newRows("legacyOrderImports")
  const newOrders = newRows("orders")
  const newItems = newRows("orderItems")
  const newRefunds = newRows("refunds")
  const newRefundItems = newRows("refundItems")
  const newAssignments = newRows("branchInventory")
  const newUserMappings = newRows("legacyUserMappings")
  const newBatches = newRows("legacyImportBatches")

  check(newImports.length === 1
    && Number(newImports[0]?.legacy_order_id) === 1100
    && Number(newImports[0]?.organization_id) === 10
    && newImports[0]?.source_system === "KE_LOGISTICS"
    && String(newImports[0]?.batch_id) === BATCH_ID, "New import ledger row mismatch")
  const order = newOrders[0]
  check(newOrders.length === 1
    && order?.tid === "KE-LEGACY-1100"
    && Number(order?.branch_id) === 222
    && order?.status === "FULFILLED"
    && order?.fulfillment_status === "DELIVERED"
    && Number(order?.subtotal_cents) === 3_719_000
    && Number(order?.tax_cents) === 0
    && Number(order?.total_cents) === 3_719_000
    && Number(order?.refund_amount_cents) === 170_000, "New order identity/status/money mismatch")
  check(newItems.length === 16
    && newItems.every((row) => Number(row.order_id) === Number(order?.id) && Number(row.organization_id) === 10)
    && newItems.reduce((sum, row) => sum + Number(row.quantity) * Number(row.price_cents), 0) === 3_719_000, "New order items mismatch")
  const mapped = newItems.filter((row) => row.product_name === "Milac Instant Tea whitener (850gm)")
  check(mapped.length === 1
    && Number(mapped[0]?.quantity) === 2
    && Number(mapped[0]?.price_cents) === 159_000
    && Number(mapped[0]?.global_product_id) === 238
    && Number(mapped[0]?.organization_inventory_id) === 248, "Approved Millac mapping mismatch")
  check(newItems.every((row) => row.product_name !== "Millac Tea Whitener 850gm"), "Source Millac label remained unmapped")

  check(newRefunds.length === 1
    && Number(newRefunds[0]?.order_id) === Number(order?.id)
    && Number(newRefunds[0]?.amount_cents) === 170_000
    && Number(newRefunds[0]?.tax_refund_cents) === 0
    && newRefunds[0]?.refund_number === "KE-R-1100"
    && newRefunds[0]?.status === "APPROVED", "New refund row mismatch")
  check(newRefundItems.length === 1
    && Number(newRefundItems[0]?.refund_id) === Number(newRefunds[0]?.id)
    && Number(newRefundItems[0]?.quantity) === 1
    && Number(newRefundItems[0]?.amount_cents) === 170_000, "New refund-item row mismatch")

  const assignmentInventoryIds = newAssignments.map((row) => Number(row.organization_inventory_id)).sort((a, b) => a - b)
  check(same(assignmentInventoryIds, EXPECTED_BRANCH_INVENTORY_IDS), "New branch-assignment product IDs mismatch")
  check(newAssignments.every((row) => Number(row.organization_id) === 10
    && Number(row.branch_id) === 222
    && row.is_active === false
    && row.is_visible === false
    && row.deleted_at === null), "New branch assignments are not exact inactive/hidden IBC Malir rows")
  check(newUserMappings.length === 1
    && Number(newUserMappings[0]?.organization_id) === 10
    && Number(newUserMappings[0]?.legacy_order_taker_id) === 138
    && Number(newUserMappings[0]?.branch_id) === 222
    && newUserMappings[0]?.source_name === "Shaikh Zeesan"
    && newUserMappings[0]?.is_synthetic === false
    && String(newUserMappings[0]?.created_by_batch_id) === BATCH_ID, "New legacy user mapping mismatch")
  check(newBatches.length === 1
    && String(newBatches[0]?.id) === BATCH_ID
    && newBatches[0]?.status === "COMPLETED"
    && Number(newBatches[0]?.counts?.orders) === 1
    && Number(newBatches[0]?.counts?.orderItems) === 16
    && Number(newBatches[0]?.counts?.refunds) === 1
    && Number(newBatches[0]?.counts?.refundItems) === 1
    && Number(newBatches[0]?.counts?.newBranchAssignments) === 16
    && Number(newBatches[0]?.counts?.newUserMappings) === 1, "New batch mismatch")

  const order192Imports = (post.legacyOrderImports as Row[]).filter((row) => Number(row.legacy_order_id) === 192)
  const order192Rows = (post.orders as Row[]).filter((row) => row.tid === "KE-LEGACY-192")
  const order192Refunds = (post.refunds as Row[]).filter((row) => row.refund_number === "KE-R-192")
  check(order192Imports.length === 0 && order192Rows.length === 0 && order192Refunds.length === 0, "Order 192 was imported")
  check(post.legacyOrderImports.length === 707 && post.orders.length === 707, "Final imported/order count is not 707")

  const result = {
    generatedAt: new Date().toISOString(),
    status: failures.length === 0 ? "PASS" : "FAILED",
    organizationId: 10,
    batchId: BATCH_ID,
    importedLegacyOrderIds: newImports.map((row) => Number(row.legacy_order_id)),
    explicitlyExcludedLegacyOrderIds: [192],
    order192Untouched: order192Imports.length === 0 && order192Rows.length === 0 && order192Refunds.length === 0,
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
