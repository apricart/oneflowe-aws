#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

type Row = Record<string, any>

const PRE_PATH = resolve("backups/ke-import-state-2026-08-04-pre-reviewed-7-orders.json")
const POST_PATH = resolve("backups/ke-import-state-2026-08-04-post-reviewed-7-orders.json")
const NORMAL_SOURCE = resolve("updatedReports/ke-current-missing-safe-candidates-2026-08-04/reports/sales-report.json")
const OUTPUT = resolve("updatedReports/ke-current-missing-safe-candidates-2026-08-04/current-production-post-validation.json")
const IDS = [250, 520, 765, 1164, 1165, 1177, 1187]
const NORMAL_IDS = new Set([250, 765, 1164, 1165, 1177, 1187])
const NORMAL_BATCH_ID = "f89cfe76-a500-4603-aa32-8b9e7c12f254"
const REFUND_BATCH_ID = "3cf300c9-d97a-4fe1-8adf-278e713a8679"

function json(path: string): any { return JSON.parse(readFileSync(path, "utf8")) }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function checksum(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex") }
function sidecar(path: string): string { return readFileSync(`${path}.sha256`, "utf8").trim().split(/\s+/)[0] }
function byId(rows: Row[]): Map<number, Row> { return new Map(rows.map((row) => [Number(row.id), row])) }

function main() {
  const pre = json(PRE_PATH)
  const post = json(POST_PATH)
  const normalSource = json(NORMAL_SOURCE) as Row[]
  const failures: string[] = []
  const check = (condition: boolean, message: string) => { if (!condition) failures.push(message) }
  check(checksum(PRE_PATH) === sidecar(PRE_PATH), "Pre-snapshot checksum mismatch")
  check(checksum(POST_PATH) === sidecar(POST_PATH), "Post-snapshot checksum mismatch")
  for (const snapshot of [pre, post]) check(snapshot.organization?.[0]?.id === 10 && snapshot.organization?.[0]?.code === "0001" && snapshot.organization?.[0]?.name === "K-Electric" && snapshot.organization?.[0]?.status === "active", "K-Electric tenant identity mismatch")

  const exactCollections = ["organization", "branches", "globalProducts", "organizationInventory", "groups", "legacyProductMappings", "budgets", "quantityBudgets", "invoiceSequence", "crossTenantCounts", "migrations"]
  for (const name of exactCollections) check(same(pre[name], post[name]), `${name} changed unexpectedly`)
  check(same(pre.globalProducts.map((row: Row) => [row.id, row.stock_quantity]), post.globalProducts.map((row: Row) => [row.id, row.stock_quantity])), "Global product stock changed")

  const existingCollections = ["users", "branchInventory", "orders", "orderItems", "refunds", "refundItems", "legacyImportBatches", "legacyUserMappings", "legacyOrderImports"]
  for (const name of existingCollections) {
    const postRows = new Map((post[name] as Row[]).map((row) => [String(row.id), row]))
    check((pre[name] as Row[]).every((row) => same(row, postRows.get(String(row.id)))), `${name} pre-existing row changed`)
  }

  const deltas = {
    orders: post.orders.length - pre.orders.length,
    orderItems: post.orderItems.length - pre.orderItems.length,
    refunds: post.refunds.length - pre.refunds.length,
    refundItems: post.refundItems.length - pre.refundItems.length,
    batches: post.legacyImportBatches.length - pre.legacyImportBatches.length,
    imports: post.legacyOrderImports.length - pre.legacyOrderImports.length,
    users: post.users.length - pre.users.length,
    userMappings: post.legacyUserMappings.length - pre.legacyUserMappings.length,
    branchInventory: post.branchInventory.length - pre.branchInventory.length,
    globalProducts: post.globalProducts.length - pre.globalProducts.length,
    organizationInventory: post.organizationInventory.length - pre.organizationInventory.length,
  }
  const expectedDeltas = { orders: 7, orderItems: 85, refunds: 1, refundItems: 2, batches: 2, imports: 7, users: 1, userMappings: 1, branchInventory: 41, globalProducts: 0, organizationInventory: 0 }
  check(same(deltas, expectedDeltas), `Unexpected deltas: ${JSON.stringify(deltas)}`)

  const preImportIds = new Set((pre.legacyOrderImports as Row[]).map((row) => Number(row.id)))
  const newImports = (post.legacyOrderImports as Row[]).filter((row) => !preImportIds.has(Number(row.id)))
  const importedIds = newImports.map((row) => Number(row.legacy_order_id)).sort((a, b) => a - b)
  check(same(importedIds, IDS), "Imported IDs are not the approved seven")
  check(new Set(newImports.map((row) => row.order_id)).size === 7, "Imported ledger order IDs are not unique")
  check(newImports.every((row) => row.organization_id === 10 && row.source_system === "KE_LOGISTICS"), "Import ledger tenant/source mismatch")
  check(newImports.filter((row) => row.batch_id === NORMAL_BATCH_ID).length === 6, "Normal batch import count mismatch")
  check(newImports.filter((row) => row.batch_id === REFUND_BATCH_ID).length === 1, "Refund batch import count mismatch")

  const orderById = byId(post.orders)
  const itemsByOrder = new Map<number, Row[]>()
  for (const item of post.orderItems as Row[]) itemsByOrder.set(Number(item.order_id), [...(itemsByOrder.get(Number(item.order_id)) ?? []), item])
  const refundByOrder = new Map((post.refunds as Row[]).map((row) => [Number(row.order_id), row]))
  const refundItemsByRefund = new Map<number, Row[]>()
  for (const item of post.refundItems as Row[]) refundItemsByRefund.set(Number(item.refund_id), [...(refundItemsByRefund.get(Number(item.refund_id)) ?? []), item])
  const expectedNormalLines = new Map<number, number>()
  const expectedNormalMoney = new Map<number, Row>()
  for (const line of normalSource) {
    const id = Number(line.ID)
    expectedNormalLines.set(id, (expectedNormalLines.get(id) ?? 0) + 1)
    expectedNormalMoney.set(id, line)
  }
  const branchById = byId(post.branches)
  const userById = new Map((post.users as Row[]).map((row) => [String(row.id), row]))
  const orgInventoryById = byId(post.organizationInventory)
  const branchInventoryPairs = new Set((post.branchInventory as Row[]).filter((row) => row.organization_id === 10 && row.deleted_at == null).map((row) => `${row.branch_id}:${row.organization_inventory_id}`))

  for (const imported of newImports) {
    const legacyId = Number(imported.legacy_order_id)
    const order = orderById.get(Number(imported.order_id))
    const items = itemsByOrder.get(Number(imported.order_id)) ?? []
    check(Boolean(order), `Missing order for ${legacyId}`)
    if (!order) continue
    check(order.tid === `KE-LEGACY-${legacyId}` && order.organization_id === 10, `TID/tenant mismatch for ${legacyId}`)
    check(branchById.get(Number(order.branch_id))?.organization_id === 10, `Branch tenant mismatch for ${legacyId}`)
    const creator = userById.get(String(order.created_by_user_id))
    check(creator?.organization_id === 10 && Number(creator?.branch_id) === Number(order.branch_id), `Creator tenant/branch mismatch for ${legacyId}`)
    check(items.every((item) => item.organization_id === 10 && Number(item.quantity) > 0 && Number(item.price_cents) >= 0), `Invalid order item for ${legacyId}`)
    check(items.reduce((sum, item) => sum + Math.round(Number(item.quantity) * Number(item.price_cents)), 0) === Number(order.subtotal_cents), `Item subtotal mismatch for ${legacyId}`)
    for (const item of items) {
      const inventory = orgInventoryById.get(Number(item.organization_inventory_id))
      check(inventory?.organization_id === 10 && Number(inventory.global_product_id) === Number(item.global_product_id), `Organization inventory mismatch for ${legacyId}`)
      check(branchInventoryPairs.has(`${order.branch_id}:${item.organization_inventory_id}`), `Branch assignment missing for ${legacyId}`)
    }
    if (NORMAL_IDS.has(legacyId)) {
      const source = expectedNormalMoney.get(legacyId)!
      check(order.status === "FULFILLED" && order.fulfillment_status === "DELIVERED" && order.refunded_at == null, `Normal status mismatch for ${legacyId}`)
      check(items.length === expectedNormalLines.get(legacyId), `Normal item count mismatch for ${legacyId}`)
      check(Number(order.subtotal_cents) === Math.round(Number(source.AmountTotal) * 100) && Number(order.tax_cents) === Math.round(Number(source.Tax) * 100) && Number(order.total_cents) === Math.round(Number(source.GrandTotal) * 100), `Normal money mismatch for ${legacyId}`)
      check(!refundByOrder.has(Number(order.id)), `Unexpected refund for ${legacyId}`)
    } else {
      const refund = refundByOrder.get(Number(order.id))
      const refundItems = refund ? refundItemsByRefund.get(Number(refund.id)) ?? [] : []
      check(order.status === "REFUNDED" && order.fulfillment_status === "DELIVERED" && Number(order.subtotal_cents) === 420500 && Number(order.refund_amount_cents) === 420500, "Refund order 520 state/money mismatch")
      check(items.length === 2 && refund?.organization_id === 10 && refund?.refund_number === "KE-R-520" && refund?.status === "APPROVED" && Number(refund?.amount_cents) === 420500, "Refund record 520 mismatch")
      check(refundItems.length === 2 && refundItems.reduce((sum, item) => sum + Number(item.amount_cents), 0) === 420500, "Refund items 520 mismatch")
    }
  }

  const partialImport = newImports.find((row) => Number(row.legacy_order_id) === 765)
  check(partialImport?.source_payload?.sourceHeader?.OriginalDeliveryStatus === 505 && partialImport?.source_payload?.sourceHeader?.MigrationStatusPolicy === "USER_APPROVED_PARTIAL_AS_DELIVERED", "Order 765 partial-policy provenance missing")
  const newUserIds = new Set((post.users as Row[]).filter((row) => !(pre.users as Row[]).some((old) => old.id === row.id)).map((row) => row.id))
  const newUsers = (post.users as Row[]).filter((row) => newUserIds.has(row.id))
  check(newUsers.length === 1 && newUsers[0].organization_id === 10 && newUsers[0].role_name === "ORDER_PORTAL" && newUsers[0].is_active === false && newUsers[0].deleted_at == null, "Historical user safety mismatch")
  const preBranchIds = new Set((pre.branchInventory as Row[]).map((row) => Number(row.id)))
  const newBranchAssignments = (post.branchInventory as Row[]).filter((row) => !preBranchIds.has(Number(row.id)))
  check(newBranchAssignments.length === 41 && newBranchAssignments.every((row) => row.organization_id === 10 && row.is_active === false && row.is_visible === false && row.deleted_at == null), "New branch assignment safety mismatch")

  const batches = (post.legacyImportBatches as Row[]).filter((row) => [NORMAL_BATCH_ID, REFUND_BATCH_ID].includes(row.id))
  check(batches.length === 2 && batches.every((row) => row.organization_id === 10 && row.source_system === "KE_LOGISTICS" && row.status === "COMPLETED"), "Batch identity/status mismatch")
  check(Number(batches.find((row) => row.id === NORMAL_BATCH_ID)?.counts?.orders) === 6, "Normal batch count mismatch")
  check(Number(batches.find((row) => row.id === REFUND_BATCH_ID)?.counts?.orders) === 1, "Refund batch count mismatch")
  check(post.legacyOrderImports.length === 702 && post.orders.length === 702, "Final K-Electric order/import count is not 702")

  const result = {
    generatedAt: new Date().toISOString(),
    status: failures.length ? "FAILED" : "PASS",
    organization: { id: 10, code: "0001", name: "K-Electric" },
    importedLegacyOrderIds: importedIds,
    batches: { normal: NORMAL_BATCH_ID, refund: REFUND_BATCH_ID },
    countsBefore: { orders: pre.orders.length, orderItems: pre.orderItems.length, refunds: pre.refunds.length, refundItems: pre.refundItems.length, legacyImports: pre.legacyOrderImports.length },
    countsAfter: { orders: post.orders.length, orderItems: post.orderItems.length, refunds: post.refunds.length, refundItems: post.refundItems.length, legacyImports: post.legacyOrderImports.length },
    deltas,
    invariants: { operationalBudgetsUnchanged: same(pre.budgets, post.budgets), quantityBudgetsUnchanged: same(pre.quantityBudgets, post.quantityBudgets), invoiceSequenceUnchanged: same(pre.invoiceSequence, post.invoiceSequence), globalStockUnchanged: same(pre.globalProducts.map((row: Row) => [row.id, row.stock_quantity]), post.globalProducts.map((row: Row) => [row.id, row.stock_quantity])), crossTenantOrdersUnchanged: same(pre.crossTenantCounts, post.crossTenantCounts) },
    snapshotChecksums: { before: checksum(PRE_PATH), after: checksum(POST_PATH) },
    failures,
  }
  writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
  console.log(JSON.stringify({ output: OUTPUT, ...result }, null, 2))
  if (failures.length) process.exitCode = 1
}

main()
