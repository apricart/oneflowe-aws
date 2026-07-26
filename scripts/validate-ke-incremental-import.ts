#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import * as dotenv from "dotenv"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ORG_ID = 10
const SOURCE_SYSTEM = "KE_LOGISTICS"

function arg(name: string, fallback: string): string {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  return resolve(inline ? inline.slice(name.length + 1) : fallback)
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function main(): Promise<void> {
  const sourceRoot = arg("--source-root", "reports/updatedReports/ke-safe-import-2026-07-23")
  const baselinePath = arg("--baseline", "backups/ke-import-state-2026-07-23-pre-incremental-51-orders.json")
  const outputPath = arg("--output", "reports/updatedReports/ke-safe-import-2026-07-23/post-import-validation.json")
  const preflight = JSON.parse(readFileSync(resolve(sourceRoot, "preflight.json"), "utf8")) as Record<string, any>
  const manifest = JSON.parse(readFileSync(resolve(sourceRoot, "candidate-manifest.json"), "utf8")) as Record<string, any>
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, any>

  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  const query = async (text: string, params: unknown[] = []): Promise<any[]> =>
    (await client.query(text, params)).rows

  try {
    await client.query("begin transaction isolation level repeatable read read only")
    const [batch] = await query(`
      select id, status, counts, source_manifest, created_at, completed_at
      from legacy_import_batches
      where organization_id = $1 and source_system = $2
        and source_manifest->>'digest' = $3
    `, [ORG_ID, SOURCE_SYSTEM, preflight.manifestDigest])
    if (!batch) throw new Error("Committed incremental batch not found")

    const importedIds = (await query(`
      select legacy_order_id from legacy_order_imports
      where batch_id = $1 order by legacy_order_id
    `, [batch.id])).map((row) => Number(row.legacy_order_id))

    const [financial] = await query(`
      select count(*)::int orders,
             coalesce(sum(o.subtotal_cents), 0)::text subtotal_cents,
             coalesce(sum(o.tax_cents), 0)::text tax_cents,
             coalesce(sum(o.total_cents), 0)::text total_cents,
             count(*) filter (where o.organization_id <> $2
               or o.status <> 'FULFILLED'
               or o.fulfillment_status <> 'DELIVERED'
               or o.payment_status <> 'UNPAID'
               or o.refund_amount_cents is not null
               or o.tid <> 'KE-LEGACY-' || loi.legacy_order_id::text)::int violations
      from legacy_order_imports loi join orders o on o.id = loi.order_id
      where loi.batch_id = $1
    `, [batch.id, ORG_ID])

    const [items] = await query(`
      select count(*)::int items,
             coalesce(sum(oi.quantity), 0)::text quantity,
             coalesce(sum(round(oi.quantity * oi.price_cents)), 0)::text subtotal_cents,
             count(*) filter (where oi.organization_id <> $2
               or oi.quantity <= 0 or oi.price_cents < 0)::int violations
      from legacy_order_imports loi join order_items oi on oi.order_id = loi.order_id
      where loi.batch_id = $1
    `, [batch.id, ORG_ID])

    const [creatorCheck] = await query(`
      select count(*) filter (where b.organization_id <> $2
        or u.organization_id <> $2 or u.branch_id <> o.branch_id
        or r.name <> 'ORDER_PORTAL')::int violations
      from legacy_order_imports loi
      join orders o on o.id = loi.order_id
      join branches b on b.id = o.branch_id
      join users u on u.id = o.created_by_user_id
      join roles r on r.id = u.role_id
      where loi.batch_id = $1
    `, [batch.id, ORG_ID])

    const product = await query(`
      select gp.id, gp.product_code, gp.name, gp.status, gp.stock_quantity::text,
             gp.deleted_at, oi.id organization_inventory_id,
             oi.organization_id, oi.is_active
      from global_products gp
      join legacy_product_mappings lpm on lpm.global_product_id = gp.id
      join organization_inventory oi on oi.id = lpm.organization_inventory_id
      where lpm.organization_id = $1 and lpm.source_system = $2
        and lpm.normalized_name = 'lipton tea bags (600 pcs)'
    `, [ORG_ID, SOURCE_SYSTEM])

    const historicalUser = await query(`
      select u.username, u.is_active, u.deleted_at, u.organization_id, u.branch_id,
             lum.legacy_order_taker_id, lum.is_synthetic, lum.created_by_batch_id
      from legacy_user_mappings lum join users u on u.id = lum.user_id
      where lum.organization_id = $1 and lum.source_system = $2
        and lum.legacy_order_taker_id = 139 and lum.branch_id = 223
    `, [ORG_ID, SOURCE_SYSTEM])

    const budgets = await query("select * from budgets where organization_id = $1 order by id", [ORG_ID])
    const quantityBudgets = await query("select * from product_quantity_budgets where organization_id = $1 order by id", [ORG_ID])
    const invoiceSequence = await query("select * from invoice_sequences where organization_id = $1", [ORG_ID])
    const crossTenantCounts = await query(`
      select organization_id, count(*)::int orders,
             coalesce(sum(total_cents), 0)::text total_cents
      from orders where organization_id is distinct from $1
      group by organization_id order by organization_id nulls first
    `, [ORG_ID])

    const priorOrders = await query(`
      select id, tid, organization_id, branch_id, status, fulfillment_status,
             payment_status, subtotal_cents, tax_cents, total_cents,
             created_by_user_id, created_at, fulfilled_at, updated_at
      from orders where id = any($1::int[]) order by id
    `, [baseline.orders.map((row: any) => row.id)])
    const priorOrderItems = await query(`
      select id, organization_id, organization_inventory_id, order_id,
             global_product_id, product_name, product_code, unit, quantity,
             price_cents, created_at
      from order_items where id = any($1::int[]) order by id
    `, [baseline.orderItems.map((row: any) => row.id)])

    const [cumulativeOrders] = await query(`
      select count(*)::int orders, coalesce(sum(total_cents), 0)::text total_cents
      from orders where organization_id = $1
    `, [ORG_ID])
    const [cumulativeLedger] = await query(`
      select count(*)::int imports, count(distinct legacy_order_id)::int distinct_ids,
             count(distinct order_id)::int distinct_orders
      from legacy_order_imports where organization_id = $1 and source_system = $2
    `, [ORG_ID, SOURCE_SYSTEM])
    const [unledgered] = await query(`
      select count(*)::int count
      from orders o left join legacy_order_imports loi on loi.order_id = o.id
      where o.tid like 'KE-LEGACY-%' and loi.id is null
    `)

    const snapshotChecks = {
      priorOrdersUnchanged: same(priorOrders, baseline.orders),
      priorOrderItemsUnchanged: same(priorOrderItems, baseline.orderItems),
      budgetsUnchanged: same(budgets, baseline.budgets),
      quantityBudgetsUnchanged: same(quantityBudgets, baseline.quantityBudgets),
      invoiceSequenceUnchanged: same(invoiceSequence, baseline.invoiceSequence),
      otherOrganizationOrderTotalsUnchanged: same(crossTenantCounts, baseline.crossTenantCounts),
    }
    const failures: string[] = []
    if (!same(importedIds, manifest.candidateOrderIds)) failures.push("candidate IDs")
    if (Number(financial.orders) !== 51
      || Number(financial.subtotal_cents) !== 383_214_700
      || Number(financial.tax_cents) !== 0
      || Number(financial.total_cents) !== 383_214_700
      || Number(financial.violations) !== 0) failures.push("financial totals/state")
    if (Number(items.items) !== 505
      || Number(items.quantity) !== 3_839
      || Number(items.subtotal_cents) !== 383_214_700
      || Number(items.violations) !== 0) failures.push("item totals/state")
    if (Number(creatorCheck.violations) !== 0) failures.push("creator tenant/role")
    if (product.length !== 1 || product[0].product_code !== "PRD--167"
      || product[0].status !== "inactive" || Number(product[0].stock_quantity) !== 0
      || product[0].organization_id !== ORG_ID || product[0].is_active !== false) failures.push("new product")
    if (historicalUser.length !== 1 || historicalUser[0].is_active !== false
      || historicalUser[0].organization_id !== ORG_ID || historicalUser[0].branch_id !== 223
      || historicalUser[0].created_by_batch_id !== batch.id) failures.push("historical user")
    for (const [name, passed] of Object.entries(snapshotChecks)) {
      if (!passed) failures.push(name)
    }
    if (Number(cumulativeOrders.orders) !== 645
      || Number(cumulativeLedger.imports) !== 645
      || Number(cumulativeLedger.distinct_ids) !== 645
      || Number(cumulativeLedger.distinct_orders) !== 645
      || Number(unledgered.count) !== 0) failures.push("cumulative ledger")

    const result = {
      status: failures.length === 0 ? "PASS" : "FAILED",
      generatedAt: new Date().toISOString(),
      organization: { id: ORG_ID, code: "0001", name: "K-Electric" },
      batchId: batch.id,
      batchStatus: batch.status,
      batchCounts: batch.counts,
      manifestDigest: preflight.manifestDigest,
      candidateIds: importedIds,
      financial,
      items,
      creatorCheck,
      product,
      historicalUser,
      cumulative: {
        ...cumulativeOrders,
        ...cumulativeLedger,
        unledgeredLegacyTids: unledgered.count,
      },
      snapshotChecks,
      failures,
    }
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
    await client.query("commit")
    console.log(JSON.stringify({ ...result, output: outputPath }, null, 2))
    if (failures.length > 0) process.exitCode = 1
  } catch (error) {
    await client.query("rollback").catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
