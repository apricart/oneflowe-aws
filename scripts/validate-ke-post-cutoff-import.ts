#!/usr/bin/env tsx
/** Read-only post-commit validator for the K-Electric post-cutoff batch. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import { verifyApprovalToken } from "../lib/approval-token"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

type Row = Record<string, any>

function argument(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main() {
  const batchId = argument("--batch-id")
  const commitReportPath = resolve(argument("--commit-report") ?? "backups/ke-post-cutoff-production-commit-2026-08-07.json")
  const sourceManifestPath = resolve(argument("--source-manifest") ?? "updatedReports/ke-post-cutoff-2026-08-07/source-manifest.json")
  const outputPath = resolve(argument("--output") ?? "backups/ke-post-cutoff-production-post-validation-2026-08-07.json")
  assert(batchId, "--batch-id is required")
  assert(existsSync(commitReportPath), `Commit report not found: ${commitReportPath}`)
  assert(existsSync(sourceManifestPath), `Source manifest not found: ${sourceManifestPath}`)
  const commitReport = JSON.parse(readFileSync(commitReportPath, "utf8")) as Row
  const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8")) as Row
  const { pool } = await import("../lib/db-cli")
  const one = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows[0] as Row
  const many = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows as Row[]
  try {
    const batch = await one(`select id,organization_id,source_system,status,counts,imported_by_user_id,created_at,completed_at
      from legacy_import_batches where id=$1`, [batchId])
    const orders = await one(`select count(*)::int orders,
      count(*) filter(where o.organization_id=10)::int ke_orders,
      count(*) filter(where o.organization_id is distinct from 10)::int non_ke_orders,
      count(*) filter(where o.status='APPROVED')::int approved,
      count(*) filter(where o.status='FULFILLED')::int fulfilled,
      count(*) filter(where o.status='APPROVED' and o.approval_token is not null and o.approval_token_hash is not null
        and o.approved_by_user_id is not null and o.approved_at is not null)::int approved_with_tokens,
      count(*) filter(where o.status='FULFILLED' and o.fulfillment_status='DELIVERED'
        and o.approval_token is null and o.approval_token_hash is null)::int fulfilled_delivered,
      coalesce(sum(o.total_cents),0)::text total_cents
      from legacy_order_imports li join orders o on o.id=li.order_id where li.batch_id=$1`, [batchId])
    const deliveryProgress = await many(`select o.status,o.fulfillment_status,count(*)::int count
      from legacy_order_imports li join orders o on o.id=li.order_id where li.batch_id=$1
      group by o.status,o.fulfillment_status order by o.status,o.fulfillment_status`, [batchId])
    const items = await one(`select count(*)::int items,coalesce(sum(round(oi.quantity*oi.price_cents)),0)::text subtotal_cents
      from legacy_order_imports li join order_items oi on oi.order_id=li.order_id
      where li.batch_id=$1 and oi.organization_id=10`, [batchId])
    const specialOrders = await many(`select li.legacy_order_id,o.tid,o.status,o.fulfillment_status,
      o.subtotal_cents::text,o.tax_cents::text,o.total_cents::text,
      li.source_payload->'legacyStatus'->>'text' legacy_status,
      li.source_payload->'migrationPolicy'->>'checkoutPolicy' checkout_policy
      from legacy_order_imports li join orders o on o.id=li.order_id
      where li.batch_id=$1 and li.legacy_order_id in (1327,1367) order by li.legacy_order_id`, [batchId])
    const cancelledImported = await one(`select count(*)::int count from legacy_order_imports
      where batch_id=$1 and legacy_order_id=any($2::int[])`, [batchId, sourceManifest.cancelledIds])
    const branches = await many(`select id,organization_id,name,address,code,external_source,external_id,group_id,baseline_budget_cents::text
      from branches where organization_id=10 and external_source='KE_LOGISTICS' and external_id in ('109','110','148')
      order by external_id`)
    const ungroupedImportedBranches = await one(`select count(distinct o.branch_id)::int count
      from legacy_order_imports li join orders o on o.id=li.order_id join branches b on b.id=o.branch_id
      where li.batch_id=$1 and b.group_id is null`, [batchId])
    const users = await one(`select count(*)::int mappings,
      count(*) filter(where m.is_synthetic)::int synthetic_mappings,
      count(*) filter(where m.is_synthetic and u.is_active=false and u.deleted_at is null
        and u.organization_id=10 and u.branch_id=m.branch_id and r.name='ORDER_PORTAL')::int valid_historical_users,
      count(*) filter(where u.organization_id is distinct from 10)::int non_ke_users
      from legacy_user_mappings m join users u on u.id=m.user_id join roles r on r.id=u.role_id
      where m.created_by_batch_id=$1`, [batchId])
    const product = await many(`select m.normalized_name,m.global_product_id,m.organization_inventory_id,p.product_code,p.name
      from legacy_product_mappings m join global_products p on p.id=m.global_product_id
      where m.organization_id=10 and m.source_system='KE_LOGISTICS'
        and m.normalized_name='millac tea whitener 850gm'`)
    const budgets = await one(`select count(*)::int ke_budget_rows,
      coalesce(sum(amount_held_cents),0)::text held_cents,
      coalesce(sum(amount_spent_cents),0)::text spent_cents from budgets where organization_id=10`)
    const holdCoverage = await one(`with required as (
        select o.branch_id,to_char(o.created_at at time zone 'UTC','YYYY-MM') period,
          sum(o.total_cents)::bigint required_hold
        from legacy_order_imports li join orders o on o.id=li.order_id
        where li.batch_id=$1 and o.status='APPROVED'
        group by o.branch_id,to_char(o.created_at at time zone 'UTC','YYYY-MM')
      ) select count(*)::int branch_months,
        count(*) filter(where b.id is not null and b.organization_id=10 and b.amount_held_cents>=r.required_hold)::int covered,
        coalesce(sum(r.required_hold),0)::text required_hold_cents
      from required r left join budgets b on b.branch_id=r.branch_id and b.period=r.period`, [batchId])
    const tenantIsolation = await one(`select
      (select count(*)::int from legacy_order_imports where batch_id=$1 and organization_id<>10) non_ke_import_ledgers,
      (select count(*)::int from audit_logs where metadata->>'batchId'=$2 and organization_id is distinct from 10) non_ke_audits`, [batchId, batchId])
    const approvedTokens = await many(`select li.legacy_order_id,o.approval_token,o.approval_token_hash
      from legacy_order_imports li join orders o on o.id=li.order_id
      where li.batch_id=$1 and o.status='APPROVED' order by li.legacy_order_id`, [batchId])
    const tokenFailures: number[] = []
    for (const row of approvedTokens) {
      if (!await verifyApprovalToken(String(row.approval_token), String(row.approval_token_hash))) {
        tokenFailures.push(Number(row.legacy_order_id))
      }
    }
    const before = commitReport.result.beforeOperationalLedgers as Row
    const after = commitReport.result.afterOperationalLedgers as Row
    const ledgerReport = {
      before,
      after,
      stockUnchanged: before.global_stock === after.global_stock,
      quantityUnchanged: before.quantity_held === after.quantity_held && before.quantity_used === after.quantity_used,
      spentUnchanged: before.spent === after.spent,
      invoiceUnchanged: before.invoice_sequence === after.invoice_sequence,
      heldDelta: Number(after.held) - Number(before.held),
    }

    assert(batch?.organization_id === 10 && batch.source_system === "KE_LOGISTICS" && batch.status === "COMPLETED",
      "Batch identity/status validation failed")
    assert(orders.orders === 111 && orders.ke_orders === 111 && orders.non_ke_orders === 0
      && orders.approved === 48 && orders.fulfilled === 63 && orders.approved_with_tokens === 48
      && orders.fulfilled_delivered === 63 && Number(orders.total_cents) === 616_864_300,
    "Order/status/token count validation failed")
    assert(items.items === 1302, "Order item count validation failed")
    assert(cancelledImported.count === 0, "A cancelled order was imported")
    assert(specialOrders.length === 2
      && specialOrders[0].legacy_order_id === 1327 && specialOrders[0].status === "FULFILLED"
      && specialOrders[0].fulfillment_status === "DELIVERED" && Number(specialOrders[0].total_cents) === 1_498_000
      && specialOrders[1].legacy_order_id === 1367 && specialOrders[1].legacy_status === "Partial"
      && specialOrders[1].status === "FULFILLED" && specialOrders[1].fulfillment_status === "DELIVERED",
    "Order 1327 or Partial policy validation failed")
    assert(branches.length === 3 && branches.every((branch) => branch.organization_id === 10)
      && branches.find((branch) => branch.external_id === "109")?.name === "liyari I"
      && branches.find((branch) => branch.external_id === "110")?.name === "BALDIA"
      && branches.find((branch) => branch.external_id === "148")?.name === "Johar Technical"
      && branches.find((branch) => branch.external_id === "148")?.address === "Cluster 3 (Johar)",
    "Branch identity validation failed")
    assert(ungroupedImportedBranches.count === 0, "An imported order branch is still ungrouped")
    assert(users.mappings === 10 && users.synthetic_mappings === 7 && users.valid_historical_users === 7 && users.non_ke_users === 0,
      "Historical user validation failed")
    assert(product.length === 1 && product[0].global_product_id === 238 && product[0].product_code === "PRD--93",
      "Millac product mapping validation failed")
    assert(Number(budgets.held_cents) === 338_457_700 && Number(budgets.spent_cents) === 0,
      "K-Electric aggregate money ledger validation failed")
    assert(holdCoverage.branch_months === 42 && holdCoverage.covered === 42
      && Number(holdCoverage.required_hold_cents) === 338_457_700, "Approved-order budget coverage validation failed")
    assert(tenantIsolation.non_ke_import_ledgers === 0 && tenantIsolation.non_ke_audits === 0, "Cross-tenant writes detected")
    assert(tokenFailures.length === 0 && approvedTokens.length === 48, "Approval token verification failed")
    assert(ledgerReport.stockUnchanged && ledgerReport.quantityUnchanged && ledgerReport.spentUnchanged
      && ledgerReport.invoiceUnchanged && ledgerReport.heldDelta === 338_457_700, "Operational ledger delta validation failed")

    const report = {
      validatedAt: new Date().toISOString(),
      result: "PASS",
      batch,
      orders,
      deliveryProgress,
      items,
      specialOrders,
      cancelledImported,
      branches,
      ungroupedImportedBranches,
      users,
      product,
      budgets,
      holdCoverage,
      tenantIsolation,
      approvalTokensVerified: approvedTokens.length,
      ledgerReport,
    }
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
    console.log(JSON.stringify({ output: outputPath, result: report.result, batchId, orders, deliveryProgress,
      items, holdCoverage, tenantIsolation, approvalTokensVerified: approvedTokens.length }, null, 2))
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
