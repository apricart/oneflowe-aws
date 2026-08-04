#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

type Row = Record<string, any>

const IDS = [145, 400, 406, 485, 672, 677, 712, 727, 771, 777, 989, 1018, 1117]
const MANIFEST = "336d989d23ef112509d49ede642963245ff8ba2d43837d5338e3fdec2334ac51"
const ACTOR = "3c0d853b-1296-4b30-b68d-fd27696e9222"
const PRE = resolve("backups/ke-import-state-2026-08-03-pre-live-resolved-13-orders.json")
const POST = resolve("backups/ke-import-state-2026-08-03-post-live-resolved-13-orders.json")
const ROOT = resolve("updatedReports/ke-live-resolved-13-orders-2026-08-03")
const OUTPUT = resolve(ROOT, "production-post-validation.json")

function json<T>(path: string): T { return JSON.parse(readFileSync(path, "utf8")) as T }
function cents(value: unknown): number { return Math.round(Number(value ?? 0) * 100) }
function same(value1: unknown, value2: unknown): boolean { return JSON.stringify(value1) === JSON.stringify(value2) }
function hash(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex") }

function main() {
  const pre = json<Row>(PRE)
  const post = json<Row>(POST)
  const headers = json<Row[]>(resolve(ROOT, "reports/order.json"))
  const sales = json<Row[]>(resolve(ROOT, "reports/sales-report.json"))
  const evidence = json<Row[]>(resolve(ROOT, "line-mapping-evidence.json"))
  const checks: Row[] = []
  const check = (name: string, pass: boolean, detail?: unknown) => checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) })
  const expectedSet = new Set(IDS)
  const beforeLedgers = (pre.legacyOrderImports as Row[]).filter((row) => expectedSet.has(Number(row.legacy_order_id)))
  const ledgers = (post.legacyOrderImports as Row[]).filter((row) => expectedSet.has(Number(row.legacy_order_id)))
  const batchIds = new Set(ledgers.map((row) => row.batch_id))
  const batch = batchIds.size === 1 ? (post.legacyImportBatches as Row[]).find((row) => row.id === [...batchIds][0]) : null
  check("No candidate existed before import", beforeLedgers.length === 0, beforeLedgers.length)
  check("Exactly 13 unique candidate ledgers exist", ledgers.length === 13 && new Set(ledgers.map((row) => row.legacy_order_id)).size === 13, ledgers.length)
  check("Candidate IDs exactly match plan", same(ledgers.map((row) => Number(row.legacy_order_id)).sort((a, b) => a - b), IDS), ledgers.map((row) => row.legacy_order_id))
  check("All candidates belong to one completed batch", batchIds.size === 1 && batch?.status === "COMPLETED", { batchIds: [...batchIds], status: batch?.status })
  check("Batch tenant/source/manifest/actor match", batch?.organization_id === 10 && batch?.source_system === "KE_LOGISTICS" && batch?.source_manifest?.digest === MANIFEST && batch?.imported_by_user_id === ACTOR, batch)
  check("Batch count permits exactly one new product and no historical users", batch?.counts?.orders === 13 && batch?.counts?.newProducts === 1 && batch?.counts?.newHistoricalUsers === 0, batch?.counts)

  const headerById = new Map(headers.map((row) => [Number(row.ID), row]))
  const salesById = new Map<number, Row[]>()
  for (const row of sales) salesById.set(Number(row.ID), [...(salesById.get(Number(row.ID)) ?? []), row])
  const orderIds = new Set(ledgers.map((row) => Number(row.order_id)))
  const orders = (post.orders as Row[]).filter((row) => orderIds.has(Number(row.id)))
  const items = (post.orderItems as Row[]).filter((row) => orderIds.has(Number(row.order_id)))
  const orderResults: Row[] = []
  let subtotal = 0, tax = 0, total = 0
  for (const legacyId of IDS) {
    const header = headerById.get(legacyId)!
    const expectedLines = salesById.get(legacyId)!
    const ledger = ledgers.find((row) => Number(row.legacy_order_id) === legacyId)
    const order = ledger ? orders.find((row) => Number(row.id) === Number(ledger.order_id)) : null
    const actualItems = order ? items.filter((row) => Number(row.order_id) === Number(order.id)).sort((a, b) => Number(a.id) - Number(b.id)) : []
    const expectedSubtotal = cents(header.AmountTotal), expectedTax = cents(header.Tax), expectedTotal = cents(header.GrandTotal)
    subtotal += expectedSubtotal; tax += expectedTax; total += expectedTotal
    const linesPass = expectedLines.length === actualItems.length && expectedLines.every((line, index) => {
      const item = actualItems[index]
      return item?.organization_id === 10
        && item.product_name === String(line.ItemDetails)
        && Number(item.quantity) === Number(line.ItemQuantity)
        && Number(item.quantity) > 0
        && Number(item.price_cents) === cents(line.UnitPrice)
    })
    const itemSubtotal = actualItems.reduce((sum, item) => sum + Math.round(Number(item.quantity) * Number(item.price_cents)), 0)
    const pass = Boolean(order)
      && order.organization_id === 10 && order.tid === `KE-LEGACY-${legacyId}`
      && order.status === "FULFILLED" && order.fulfillment_status === "DELIVERED"
      && Number(order.subtotal_cents) === expectedSubtotal && Number(order.tax_cents) === expectedTax && Number(order.total_cents) === expectedTotal
      && linesPass && itemSubtotal === expectedSubtotal
      && !(post.refunds as Row[]).some((refund) => Number(refund.order_id) === Number(order.id))
    orderResults.push({ legacyId, orderId: order?.id ?? null, items: actualItems.length, itemSubtotal, expectedSubtotal, pass })
  }
  check("All 13 orders and positive-quantity lines match reviewed source", orderResults.every((row) => row.pass), orderResults.filter((row) => !row.pass))
  check("Exactly 122 positive-quantity items persisted", items.length === 122 && items.every((row) => Number(row.quantity) > 0), items.length)
  check("All 15 zero-quantity source artifacts stayed excluded", evidence.filter((row) => row.importTreatment === "EXCLUDED_ZERO_QUANTITY_ARTIFACT").length === 15 && items.length === evidence.filter((row) => row.importTreatment === "INCLUDED").length, { excluded: evidence.filter((row) => row.importTreatment === "EXCLUDED_ZERO_QUANTITY_ARTIFACT").length })
  check("Aggregate financials match", orders.reduce((sum, row) => sum + Number(row.subtotal_cents), 0) === subtotal && orders.reduce((sum, row) => sum + Number(row.tax_cents), 0) === tax && orders.reduce((sum, row) => sum + Number(row.total_cents), 0) === total, { subtotal, tax, total })

  const newUsers = (post.users as Row[]).filter((row) => !(pre.users as Row[]).some((before) => before.id === row.id))
  const newProducts = (post.globalProducts as Row[]).filter((row) => !(pre.globalProducts as Row[]).some((before) => before.id === row.id))
  const newOrgInventory = (post.organizationInventory as Row[]).filter((row) => !(pre.organizationInventory as Row[]).some((before) => before.id === row.id))
  const toothbrush = newProducts.find((row) => row.name === "Toothbrush Colgate")
  const toothbrushOrg = newOrgInventory.find((row) => row.global_product_id === toothbrush?.id)
  check("No user was created", newUsers.length === 0, newUsers)
  check("Exactly one inactive zero-stock Toothbrush Colgate product was created", newProducts.length === 1 && toothbrush?.status === "inactive" && Number(toothbrush?.base_price_cents) === 0 && Number(toothbrush?.stock_quantity) === 0, newProducts)
  check("Exactly one inactive K-Electric inventory assignment was created for the historical product", newOrgInventory.length === 1 && toothbrushOrg?.organization_id === 10 && toothbrushOrg?.is_active === false && Number(toothbrushOrg?.custom_price_cents) === 0 && toothbrushOrg?.deleted_at === null, newOrgInventory)
  const newBranchAssignments = (post.branchInventory as Row[]).filter((row) => !(pre.branchInventory as Row[]).some((before) => before.id === row.id))
  check("New branch assignments are K-Electric-only, inactive and invisible", newBranchAssignments.length > 0 && newBranchAssignments.every((row) => row.organization_id === 10 && row.is_active === false && row.is_visible === false && row.deleted_at === null), newBranchAssignments.length)
  check("Refund records were unchanged", same(pre.refunds, post.refunds) && same(pre.refundItems, post.refundItems), { refunds: post.refunds.length, refundItems: post.refundItems.length })
  check("Budgets, quantity budgets and invoice sequence were unchanged", same(pre.budgets, post.budgets) && same(pre.quantityBudgets, post.quantityBudgets) && same(pre.invoiceSequence, post.invoiceSequence), null)
  const preStocks = new Map((pre.globalProducts as Row[]).map((row) => [row.id, row.stock_quantity]))
  check("All pre-existing product stocks were unchanged", (post.globalProducts as Row[]).filter((row) => preStocks.has(row.id)).every((row) => preStocks.get(row.id) === row.stock_quantity), null)

  const failures = checks.filter((row) => !row.pass)
  const report = {
    generatedAt: new Date().toISOString(), status: failures.length ? "FAIL" : "PASS", organizationId: 10,
    batchId: batch?.id ?? null, legacyOrderIds: IDS,
    counts: { orders: orders.length, items: items.length, excludedZeroQuantityArtifacts: 15, newUsers: newUsers.length, newProducts: newProducts.length, newOrganizationInventory: newOrgInventory.length, newBranchAssignments: newBranchAssignments.length },
    financials: { subtotalCents: subtotal, taxCents: tax, totalCents: total },
    snapshotHashes: { pre: hash(PRE), post: hash(POST) }, checks, failures, orderResults,
  }
  writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log(JSON.stringify({ output: OUTPUT, ...report, checks: { total: checks.length, passed: checks.length - failures.length, failed: failures.length }, orderResults: undefined }, null, 2))
  if (failures.length) process.exitCode = 1
}

main()
