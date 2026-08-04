#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

type Row = Record<string, any>

const EXPECTED_IDS = [118, 154, 158, 159, 161, 216, 217, 628, 704, 936, 997, 1029, 1032, 1083, 1099, 1102, 1112, 1131, 1156]
const EXPECTED_MANIFEST = "ee1c8cd7420169b26901c8222fd6812087f6962cbee691ab2869cc342a5b8abd"
const EXPECTED_ACTOR = "3c0d853b-1296-4b30-b68d-fd27696e9222"
const PRE = resolve("backups/ke-import-state-2026-08-03-pre-live-price-reconciled-19-orders.json")
const POST = resolve("backups/ke-import-state-2026-08-03-post-live-price-reconciled-19-orders.json")
const SOURCE_ROOT = resolve("updatedReports/ke-live-price-reconciled-19-orders-2026-08-03/reports")
const OUTPUT = resolve("updatedReports/ke-live-price-reconciled-19-orders-2026-08-03/production-post-validation.json")

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

function cents(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100)
}

function stable(value: unknown): string {
  return JSON.stringify(value)
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function main() {
  const pre = readJson<Row>(PRE)
  const post = readJson<Row>(POST)
  const headers = readJson<Row[]>(resolve(SOURCE_ROOT, "order.json"))
  const sales = readJson<Row[]>(resolve(SOURCE_ROOT, "sales-report.json"))
  const checks: Array<{ name: string; pass: boolean; detail?: unknown }> = []
  const check = (name: string, condition: boolean, detail?: unknown) => {
    checks.push({ name, pass: condition, ...(detail === undefined ? {} : { detail }) })
  }
  const expectedSet = new Set(EXPECTED_IDS)
  const headersById = new Map(headers.map((row) => [Number(row.ID), row]))
  const salesById = new Map<number, Row[]>()
  for (const row of sales) {
    const id = Number(row.ID)
    salesById.set(id, [...(salesById.get(id) ?? []), row])
  }

  const candidateLedgers = (post.legacyOrderImports as Row[]).filter((row) => expectedSet.has(Number(row.legacy_order_id)))
  const preCandidateLedgers = (pre.legacyOrderImports as Row[]).filter((row) => expectedSet.has(Number(row.legacy_order_id)))
  const batchIds = new Set(candidateLedgers.map((row) => row.batch_id))
  const batch = batchIds.size === 1
    ? (post.legacyImportBatches as Row[]).find((row) => row.id === [...batchIds][0])
    : null
  check("No candidate order was imported before this batch", preCandidateLedgers.length === 0, preCandidateLedgers.length)
  check("Exactly 19 candidate import-ledger rows exist", candidateLedgers.length === 19, candidateLedgers.length)
  check("Candidate legacy IDs are exact and unique", stable(candidateLedgers.map((row) => Number(row.legacy_order_id)).sort((a, b) => a - b)) === stable(EXPECTED_IDS), candidateLedgers.map((row) => row.legacy_order_id))
  check("All candidate rows belong to one import batch", batchIds.size === 1, [...batchIds])
  check("Import batch exists and completed", Boolean(batch) && batch.status === "COMPLETED", batch?.status)
  check("Import batch is K-Electric only", batch?.organization_id === 10 && batch?.source_system === "KE_LOGISTICS", batch ? { organizationId: batch.organization_id, sourceSystem: batch.source_system } : null)
  check("Import manifest matches reviewed digest", batch?.source_manifest?.digest === EXPECTED_MANIFEST, batch?.source_manifest?.digest)
  check("Import actor matches reviewed super-admin", batch?.imported_by_user_id === EXPECTED_ACTOR, batch?.imported_by_user_id)
  check("Batch counts match plan", batch?.counts?.orders === 19 && batch?.counts?.newProducts === 0 && batch?.counts?.newHistoricalUsers === 1, batch?.counts)

  const persistedOrderIds = new Set(candidateLedgers.map((row) => Number(row.order_id)))
  const persistedOrders = (post.orders as Row[]).filter((row) => persistedOrderIds.has(Number(row.id)))
  const persistedItems = (post.orderItems as Row[]).filter((row) => persistedOrderIds.has(Number(row.order_id)))
  let expectedSubtotalCents = 0
  let expectedTaxCents = 0
  let expectedTotalCents = 0
  const orderResults: Row[] = []
  for (const legacyId of EXPECTED_IDS) {
    const header = headersById.get(legacyId)!
    const expectedLines = salesById.get(legacyId)!
    const ledger = candidateLedgers.find((row) => Number(row.legacy_order_id) === legacyId)
    const order = ledger ? persistedOrders.find((row) => Number(row.id) === Number(ledger.order_id)) : null
    const items = order ? persistedItems.filter((row) => Number(row.order_id) === Number(order.id)).sort((a, b) => Number(a.id) - Number(b.id)) : []
    const subtotalCents = cents(header.AmountTotal)
    const taxCents = cents(header.Tax)
    const totalCents = cents(header.GrandTotal)
    expectedSubtotalCents += subtotalCents
    expectedTaxCents += taxCents
    expectedTotalCents += totalCents
    const lineChecks = expectedLines.map((line, index) => {
      const item = items[index]
      return Boolean(item)
        && item.organization_id === 10
        && item.product_name === String(line.ItemDetails)
        && Number(item.quantity) === Number(line.ItemQuantity)
        && Number(item.price_cents) === cents(line.UnitPrice)
    })
    const itemSubtotal = items.reduce((sum, item) => sum + Math.round(Number(item.quantity) * Number(item.price_cents)), 0)
    const pass = Boolean(order)
      && order.organization_id === 10
      && order.tid === `KE-LEGACY-${legacyId}`
      && order.status === "FULFILLED"
      && order.fulfillment_status === "DELIVERED"
      && Number(order.subtotal_cents) === subtotalCents
      && Number(order.tax_cents) === taxCents
      && Number(order.total_cents) === totalCents
      && items.length === expectedLines.length
      && lineChecks.every(Boolean)
      && itemSubtotal === subtotalCents
      && !(post.refunds as Row[]).some((refund) => Number(refund.order_id) === Number(order.id))
    orderResults.push({ legacyId, orderId: order?.id ?? null, items: items.length, subtotalCents, taxCents, totalCents, itemSubtotalCents: itemSubtotal, pass })
  }
  check("All 19 persisted orders and every item line match the reviewed source", orderResults.every((row) => row.pass), orderResults.filter((row) => !row.pass))
  check("Exactly 218 candidate item rows persisted", persistedItems.length === 218, persistedItems.length)
  check("Aggregate subtotal matches", persistedOrders.reduce((sum, row) => sum + Number(row.subtotal_cents), 0) === expectedSubtotalCents, expectedSubtotalCents)
  check("Aggregate tax matches", persistedOrders.reduce((sum, row) => sum + Number(row.tax_cents), 0) === expectedTaxCents, expectedTaxCents)
  check("Aggregate total matches", persistedOrders.reduce((sum, row) => sum + Number(row.total_cents), 0) === expectedTotalCents, expectedTotalCents)

  const newUsers = (post.users as Row[]).filter((row) => !(pre.users as Row[]).some((before) => before.id === row.id))
  const historicalUser = newUsers.find((row) => row.username === "legacy_ke_136_10")
  const newUserMappings = (post.legacyUserMappings as Row[]).filter((row) => !(pre.legacyUserMappings as Row[]).some((before) => before.id === row.id))
  check("Exactly one inactive historical user was created", newUsers.length === 1 && historicalUser?.organization_id === 10 && historicalUser?.branch_id === 136 && historicalUser?.role_name === "ORDER_PORTAL" && historicalUser?.is_active === false && historicalUser?.deleted_at === null, newUsers)
  check("Historical user mapping exists for legacy taker 10", newUserMappings.some((row) => row.legacy_order_taker_id === 10 && row.branch_id === 136 && row.user_id === historicalUser?.id && row.is_synthetic === true), newUserMappings)

  const newProducts = (post.globalProducts as Row[]).filter((row) => !(pre.globalProducts as Row[]).some((before) => before.id === row.id))
  const newOrgInventory = (post.organizationInventory as Row[]).filter((row) => !(pre.organizationInventory as Row[]).some((before) => before.id === row.id))
  const newProductMappings = (post.legacyProductMappings as Row[]).filter((row) => !(pre.legacyProductMappings as Row[]).some((before) => before.id === row.id))
  const expectedProductMappings = new Map([
    ["cell-toshiba (aa", 212],
    ["nescafe classic coffee (gold 100 gm)", 259],
    ["spoon (3 pcs)", 221],
  ])
  check("No global products were created", newProducts.length === 0, newProducts)
  check("No organization-inventory products were created", newOrgInventory.length === 0, newOrgInventory)
  check("Exactly three reviewed legacy product mappings were added", newProductMappings.length === 3 && newProductMappings.every((row) => expectedProductMappings.get(row.normalized_name) === row.global_product_id), newProductMappings)

  const newBranchAssignments = (post.branchInventory as Row[]).filter((row) => !(pre.branchInventory as Row[]).some((before) => before.id === row.id))
  check("New historical branch assignments are K-Electric-only, inactive, and invisible", newBranchAssignments.length > 0 && newBranchAssignments.every((row) => row.organization_id === 10 && row.is_active === false && row.is_visible === false && row.deleted_at === null), { count: newBranchAssignments.length })
  check("Refund tables were unchanged", stable(pre.refunds) === stable(post.refunds) && stable(pre.refundItems) === stable(post.refundItems), { refundsBefore: pre.refunds.length, refundsAfter: post.refunds.length })
  check("Budgets were unchanged", stable(pre.budgets) === stable(post.budgets), { before: pre.budgets.length, after: post.budgets.length })
  check("Quantity budgets were unchanged", stable(pre.quantityBudgets) === stable(post.quantityBudgets), { before: pre.quantityBudgets.length, after: post.quantityBudgets.length })
  check("Invoice sequence was unchanged", stable(pre.invoiceSequence) === stable(post.invoiceSequence), { before: pre.invoiceSequence, after: post.invoiceSequence })
  const preStocks = new Map((pre.globalProducts as Row[]).map((row) => [row.id, row.stock_quantity]))
  check("All existing global-product stocks were unchanged", (post.globalProducts as Row[]).every((row) => preStocks.get(row.id) === row.stock_quantity), null)

  const failures = checks.filter((row) => !row.pass)
  const result = {
    generatedAt: new Date().toISOString(),
    status: failures.length === 0 ? "PASS" : "FAIL",
    organizationId: 10,
    batchId: batch?.id ?? null,
    legacyOrderIds: EXPECTED_IDS,
    counts: {
      orders: persistedOrders.length,
      items: persistedItems.length,
      newHistoricalUsers: newUsers.length,
      newProductMappings: newProductMappings.length,
      newBranchAssignments: newBranchAssignments.length,
      newProducts: newProducts.length,
      newOrganizationInventory: newOrgInventory.length,
    },
    financials: {
      subtotalCents: expectedSubtotalCents,
      taxCents: expectedTaxCents,
      totalCents: expectedTotalCents,
    },
    snapshotHashes: { pre: hashFile(PRE), post: hashFile(POST) },
    checks,
    failures,
    orderResults,
  }
  writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, "utf8")
  console.log(JSON.stringify({ output: OUTPUT, ...result, checks: { total: checks.length, passed: checks.length - failures.length, failed: failures.length }, orderResults: undefined }, null, 2))
  if (failures.length > 0) process.exitCode = 1
}

main()
