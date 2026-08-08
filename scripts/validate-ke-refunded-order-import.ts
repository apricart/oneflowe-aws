#!/usr/bin/env tsx

import { createHash } from "crypto"
import { readFileSync, writeFileSync } from "fs"
import { resolve } from "path"

type Row = Record<string, any>

const ORG_ID = 10
const SOURCE = "KE_LOGISTICS"

function arg(name: string, fallback: string): string {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(resolve(path), "utf8"))
}

function checksum(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(path))).digest("hex")
}

function sidecarChecksum(path: string): string {
  return readFileSync(resolve(`${path}.sha256`), "utf8").trim().split(/\s+/)[0].toLowerCase()
}

function cents(value: unknown): number {
  return Math.round((Number(value ?? 0) + Number.EPSILON) * 100)
}

function mapBy(rows: Row[], key: (row: Row) => string): Map<string, Row> {
  return new Map(rows.map((row) => [key(row), row]))
}

function same(valueA: unknown, valueB: unknown): boolean {
  return JSON.stringify(valueA) === JSON.stringify(valueB)
}

function main() {
  const beforePath = arg("--before", "backups/ke-import-state-2026-08-03-pre-refund-aware-18-orders.json")
  const afterPath = arg("--after", "backups/ke-import-state-2026-08-03-post-refund-aware-18-orders.json")
  const preflightPath = arg("--preflight", "updatedReports/ke-production-refund-import-preflight-2026-08-03-v6.json")
  const refundReportPath = arg("--refund-report", "updatedReports/refundReport.json")
  const outputPath = resolve(arg("--output", "updatedReports/ke-production-refund-import-post-validation-2026-08-03.json"))
  const batchId = arg("--batch-id", "ada50cb1-fbe7-4a00-8d46-0c20f158efbc")

  const before = readJson(beforePath)
  const after = readJson(afterPath)
  const preflight = readJson(preflightPath)
  const refundHeaders = readJson(refundReportPath) as Row[]
  const failures: string[] = []
  const check = (condition: boolean, message: string) => {
    if (!condition) failures.push(message)
  }

  check(checksum(beforePath) === sidecarChecksum(beforePath), "Before snapshot checksum mismatch")
  check(checksum(afterPath) === sidecarChecksum(afterPath), "After snapshot checksum mismatch")
  check(before.organizationId === ORG_ID && after.organizationId === ORG_ID, "Snapshot organization ID mismatch")
  check(before.organization?.[0]?.id === ORG_ID && before.organization?.[0]?.code === "0001" && before.organization?.[0]?.name === "K-Electric", "Before tenant identity mismatch")
  check(after.organization?.[0]?.id === ORG_ID && after.organization?.[0]?.code === "0001" && after.organization?.[0]?.name === "K-Electric", "After tenant identity mismatch")

  const expected = preflight.totals
  const expectedLegacyIds = (preflight.readyOrderIds as number[]).map(Number).sort((a, b) => a - b)
  const expectedLegacyIdSet = new Set(expectedLegacyIds)
  check(expected.readyOrders === 18 && expectedLegacyIds.length === 18, "Expected manifest order count is not 18")
  check(preflight.manifestDigest === "62cf71dd93d5ebd724fa96a989ea1e3f8716490a7344e00e78a5bb70d0e742c7", "Unexpected manifest digest")

  const exactCollections = [
    "organization", "branches", "users", "globalProducts", "organizationInventory",
    "groups", "legacyProductMappings", "budgets", "quantityBudgets", "invoiceSequence",
    "crossTenantCounts",
  ]
  for (const name of exactCollections) check(same(before[name], after[name]), `${name} changed unexpectedly`)

  const existingCollections = ["orders", "orderItems", "branchInventory", "legacyImportBatches", "legacyUserMappings", "legacyOrderImports"]
  for (const name of existingCollections) {
    const afterById = mapBy(after[name], (row) => String(row.id))
    const changed = before[name].filter((row: Row) => !same(row, afterById.get(String(row.id))))
    check(changed.length === 0, `${name}: ${changed.length} pre-existing rows changed`)
  }

  const deltas = {
    orders: after.orders.length - before.orders.length,
    orderItems: after.orderItems.length - before.orderItems.length,
    refunds: after.refunds.length - before.refunds.length,
    refundItems: after.refundItems.length - before.refundItems.length,
    branchInventory: after.branchInventory.length - before.branchInventory.length,
    legacyImportBatches: after.legacyImportBatches.length - before.legacyImportBatches.length,
    legacyUserMappings: after.legacyUserMappings.length - before.legacyUserMappings.length,
    legacyOrderImports: after.legacyOrderImports.length - before.legacyOrderImports.length,
  }
  check(deltas.orders === expected.readyOrders, `Order delta ${deltas.orders} != ${expected.readyOrders}`)
  check(deltas.orderItems === expected.readyOrderItems, `Order-item delta ${deltas.orderItems} != ${expected.readyOrderItems}`)
  check(deltas.refunds === expected.readyOrders, `Refund delta ${deltas.refunds} != ${expected.readyOrders}`)
  check(deltas.refundItems === expected.readyRefundItems, `Refund-item delta ${deltas.refundItems} != ${expected.readyRefundItems}`)
  check(deltas.branchInventory === preflight.newBranchAssignments.length, "Branch-inventory delta mismatch")
  check(deltas.legacyImportBatches === 1, "Legacy batch delta mismatch")
  check(deltas.legacyUserMappings === preflight.newUserMappings.length, "Legacy user-mapping delta mismatch")
  check(deltas.legacyOrderImports === expected.readyOrders, "Legacy order-import delta mismatch")

  const beforeOrderIds = new Set(before.orders.map((row: Row) => Number(row.id)))
  const beforeOrderItemIds = new Set(before.orderItems.map((row: Row) => Number(row.id)))
  const beforeRefundIds = new Set(before.refunds.map((row: Row) => Number(row.id)))
  const beforeRefundItemIds = new Set(before.refundItems.map((row: Row) => Number(row.id)))
  const newOrders = after.orders.filter((row: Row) => !beforeOrderIds.has(Number(row.id)))
  const newOrderItems = after.orderItems.filter((row: Row) => !beforeOrderItemIds.has(Number(row.id)))
  const newRefunds = after.refunds.filter((row: Row) => !beforeRefundIds.has(Number(row.id)))
  const newRefundItems = after.refundItems.filter((row: Row) => !beforeRefundItemIds.has(Number(row.id)))
  const newImports = after.legacyOrderImports.filter((row: Row) => row.batch_id === batchId)
  const batch = after.legacyImportBatches.find((row: Row) => row.id === batchId)

  check(batch?.organization_id === ORG_ID && batch?.source_system === SOURCE && batch?.status === "COMPLETED", "Batch identity/status mismatch")
  check(batch?.source_manifest?.digest === preflight.manifestDigest && batch?.source_manifest?.kind === "REFUND_AWARE", "Batch manifest mismatch")
  check(batch?.imported_by_user_id === preflight.latestLegacyImportActorUserId, "Batch actor mismatch")
  check(Number(batch?.counts?.orders) === expected.readyOrders, "Batch order count mismatch")
  check(Number(batch?.counts?.orderItems) === expected.readyOrderItems, "Batch order-item count mismatch")
  check(Number(batch?.counts?.refunds) === expected.readyOrders, "Batch refund count mismatch")
  check(Number(batch?.counts?.refundItems) === expected.readyRefundItems, "Batch refund-item count mismatch")

  const newImportIds = newImports.map((row: Row) => Number(row.legacy_order_id)).sort((a: number, b: number) => a - b)
  check(same(newImportIds, expectedLegacyIds), "Imported legacy order IDs do not equal the pinned manifest")
  check(newImports.every((row: Row) => row.organization_id === ORG_ID && row.source_system === SOURCE && row.source_payload?.kind === "REFUND_AWARE"), "Import ledger tenant/source/payload mismatch")

  const orderById = mapBy(newOrders, (row) => String(row.id))
  const itemsByOrderId = new Map<string, Row[]>()
  for (const item of newOrderItems) itemsByOrderId.set(String(item.order_id), [...(itemsByOrderId.get(String(item.order_id)) ?? []), item])
  const refundByOrderId = mapBy(newRefunds, (row) => String(row.order_id))
  const refundItemsByRefundId = new Map<string, Row[]>()
  for (const item of newRefundItems) refundItemsByRefundId.set(String(item.refund_id), [...(refundItemsByRefundId.get(String(item.refund_id)) ?? []), item])
  const userById = mapBy(after.users, (row: Row) => String(row.id))
  const branchById = mapBy(after.branches, (row: Row) => String(row.id))
  const orgInventoryById = mapBy(after.organizationInventory, (row: Row) => String(row.id))
  const branchInventoryPairs = new Set(after.branchInventory
    .filter((row: Row) => row.organization_id === ORG_ID && row.deleted_at === null)
    .map((row: Row) => `${row.branch_id}:${row.organization_inventory_id}`))
  const headerById = new Map(refundHeaders.map((row) => [Number(row.ID), row]))

  let grossCents = 0
  let refundCents = 0
  for (const imported of newImports) {
    const legacyId = Number(imported.legacy_order_id)
    const order = orderById.get(String(imported.order_id))
    const header = headerById.get(legacyId)
    const orderLines = itemsByOrderId.get(String(imported.order_id)) ?? []
    const refund = refundByOrderId.get(String(imported.order_id))
    const itemRefunds = refund ? refundItemsByRefundId.get(String(refund.id)) ?? [] : []
    check(expectedLegacyIdSet.has(legacyId), `Unexpected legacy ID ${legacyId}`)
    check(Boolean(order && header && refund), `Order/header/refund missing for ${legacyId}`)
    if (!order || !header || !refund) continue

    const expectedTotal = cents(header.GrandTotal)
    const expectedSubtotal = cents(header.AmountTotal)
    const expectedRefund = cents(header.RefundAmount)
    grossCents += Number(order.total_cents)
    refundCents += Number(order.refund_amount_cents)
    check(order.tid === `KE-LEGACY-${legacyId}`, `TID mismatch for ${legacyId}`)
    check(order.organization_id === ORG_ID && branchById.get(String(order.branch_id))?.organization_id === ORG_ID, `Order tenant/branch mismatch for ${legacyId}`)
    const creator = userById.get(String(order.created_by_user_id))
    check(creator?.organization_id === ORG_ID && creator?.branch_id === order.branch_id, `Order creator tenant/branch mismatch for ${legacyId}`)
    check(order.fulfillment_status === "DELIVERED" && order.payment_status === "UNPAID" && order.status_at_refund === "FULFILLED", `Order state mismatch for ${legacyId}`)
    check(order.status === (expectedRefund === expectedTotal ? "REFUNDED" : "FULFILLED"), `Full/partial refund status mismatch for ${legacyId}`)
    check(Number(order.subtotal_cents) === expectedSubtotal && Number(order.tax_cents) === cents(header.Tax) && Number(order.total_cents) === expectedTotal, `Order money mismatch for ${legacyId}`)
    check(Number(order.refund_amount_cents) === expectedRefund, `Order refund mismatch for ${legacyId}`)
    check(order.refunded_by_user_id === preflight.latestLegacyImportActorUserId, `Order refund actor mismatch for ${legacyId}`)
    check(orderLines.length > 0 && orderLines.every((line) => line.organization_id === ORG_ID && Number(line.quantity) > 0 && Number(line.price_cents) >= 0), `Invalid order items for ${legacyId}`)
    check(orderLines.reduce((sum, line) => sum + Math.round(Number(line.quantity) * Number(line.price_cents)), 0) === expectedSubtotal, `Order-item subtotal mismatch for ${legacyId}`)
    for (const line of orderLines) {
      const inventory = orgInventoryById.get(String(line.organization_inventory_id))
      check(inventory?.organization_id === ORG_ID && inventory?.global_product_id === line.global_product_id, `Organization inventory mismatch for ${legacyId}/${line.id}`)
      check(branchInventoryPairs.has(`${order.branch_id}:${line.organization_inventory_id}`), `Branch inventory missing for ${legacyId}/${line.id}`)
    }
    check(refund.organization_id === ORG_ID && refund.order_id === order.id && refund.status === "APPROVED", `Refund state/tenant mismatch for ${legacyId}`)
    check(refund.refund_number === `KE-R-${legacyId}` && Number(refund.amount_cents) === expectedRefund, `Refund number/amount mismatch for ${legacyId}`)
    check(refund.processed_by_user_id === preflight.latestLegacyImportActorUserId, `Refund actor mismatch for ${legacyId}`)
    check(itemRefunds.length > 0 && itemRefunds.reduce((sum, item) => sum + Number(item.amount_cents), 0) === expectedRefund, `Refund-item total mismatch for ${legacyId}`)
    const orderLineById = mapBy(orderLines, (row) => String(row.id))
    check(itemRefunds.every((item) => {
      const line = orderLineById.get(String(item.order_item_id))
      return Boolean(line && Number(item.quantity) > 0 && Number(item.quantity) <= Number(line.quantity)
        && Number(item.amount_cents) === Math.round(Number(item.quantity) * Number(line.price_cents)))
    }), `Refund-item quantity/price mismatch for ${legacyId}`)
  }
  check(grossCents === expected.readyGrossCents, "Imported gross total mismatch")
  check(refundCents === expected.readyRefundCents, "Imported refund total mismatch")

  const result = {
    generatedAt: new Date().toISOString(),
    status: failures.length === 0 ? "PASS" : "FAILED",
    organization: { id: ORG_ID, code: "0001", name: "K-Electric" },
    batchId,
    manifestDigest: preflight.manifestDigest,
    snapshotChecksums: { before: checksum(beforePath), after: checksum(afterPath) },
    countsBefore: {
      orders: before.orders.length,
      orderItems: before.orderItems.length,
      refunds: before.refunds.length,
      refundItems: before.refundItems.length,
      legacyImports: before.legacyOrderImports.length,
    },
    countsAfter: {
      orders: after.orders.length,
      orderItems: after.orderItems.length,
      refunds: after.refunds.length,
      refundItems: after.refundItems.length,
      legacyImports: after.legacyOrderImports.length,
    },
    deltas,
    importedLegacyOrderIds: newImportIds,
    totals: { grossCents, refundCents },
    operationalLedgersUnchanged: {
      budgets: same(before.budgets, after.budgets),
      quantityBudgets: same(before.quantityBudgets, after.quantityBudgets),
      invoiceSequence: same(before.invoiceSequence, after.invoiceSequence),
      crossTenantOrderTotals: same(before.crossTenantCounts, after.crossTenantCounts),
    },
    failures,
  }
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
  console.log(JSON.stringify({ ...result, output: outputPath }, null, 2))
  if (failures.length > 0) process.exitCode = 1
}

main()
