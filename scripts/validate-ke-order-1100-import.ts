#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { PoolClient } from "pg"

import { pool } from "../lib/db-cli"
import { KE_ORGANIZATION, LEGACY_SOURCE } from "../lib/legacy-import/ke-electric"

type Row = Record<string, any>

const LEGACY_ORDER_ID = 1100
const EXCLUDED_ORDER_ID = 192
const EXPECTED_BATCH_ID = "67eda412-2efc-4c6a-b298-aea863e968c2"
const SOURCE_PRODUCT = "Millac Tea Whitener 850gm"
const TARGET_PRODUCT = "Milac Instant Tea whitener (850gm)"
const REPORT_PATH = resolve("updatedReports/ke-order-1100-millac-mapping-2026-08-05/source.json")
const AUDIT_PATH = resolve("updatedReports/ke-order-1100-millac-mapping-2026-08-05/evidence.json")

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex")
}

function stableDigest(value: unknown): string {
  return sha256(JSON.stringify(value))
}

async function rows(client: PoolClient, text: string, params: unknown[] = []): Promise<Row[]> {
  return (await client.query(text, params)).rows
}

async function operationalState(client: PoolClient, productIds: number[]) {
  const [budgets, quantityBudgets, invoiceSequences, stocks] = await Promise.all([
    rows(client, "select id, amount_allocated_cents, amount_spent_cents, amount_held_cents, amount_credited_cents from budgets where organization_id = $1 order by id", [KE_ORGANIZATION.id]),
    rows(client, "select id, allocated_quantity, held_quantity, used_quantity, credited_quantity, amount_allocated_cents, amount_credited_cents from product_quantity_budgets where organization_id = $1 order by id", [KE_ORGANIZATION.id]),
    rows(client, "select organization_id, last_value from invoice_sequences where organization_id = $1 order by organization_id", [KE_ORGANIZATION.id]),
    rows(client, "select id, stock_quantity from global_products where id = any($1::int[]) order by id", [productIds]),
  ])
  return { budgets, quantityBudgets, invoiceSequences, stocks }
}

async function main() {
  const output = arg("--output") ? resolve(arg("--output")!) : undefined
  const reportBuffer = readFileSync(REPORT_PATH)
  const auditBuffer = readFileSync(AUDIT_PATH)
  const report = JSON.parse(reportBuffer.toString("utf8")) as Row[]
  const audit = JSON.parse(auditBuffer.toString("utf8")) as Row
  const header = report[0]
  const detail = audit.details[0]
  const modal = audit.refundModalEvidence.responses[0]
  const evidence = audit.refundModalEvidence.orderEvidence[0]
  const manifestFiles = [
    `refundAudit:${sha256(auditBuffer)}`,
    `refundReport:${sha256(reportBuffer)}`,
  ]
  const expectedManifestDigest = stableDigest(manifestFiles)
  const expectedSourceChecksum = stableDigest({ header, detail, modal, evidence })
  const failures: string[] = []
  const check = (condition: unknown, message: string) => { if (!condition) failures.push(message) }

  check(report.length === 1 && Number(header?.ID) === LEGACY_ORDER_ID, "Scoped report is not exactly order 1100")
  check(JSON.stringify(header?.ExplicitlyExcludedLegacyOrderIds) === JSON.stringify([EXCLUDED_ORDER_ID]), "Order 192 exclusion provenance is missing")
  check(header?.ProductMappingPolicy === "USER_APPROVED_EXACT_TARGET_MAPPING", "Approved product-mapping policy is missing")

  const client = await pool.connect()
  try {
    await client.query("begin transaction isolation level repeatable read read only")
    const imported = await rows(client, `
      select loi.legacy_order_id, loi.source_checksum, loi.source_payload, loi.batch_id,
             o.id as order_id, o.tid, o.organization_id, o.branch_id, o.created_by_user_id,
             o.status, o.fulfillment_status, o.payment_status, o.subtotal_cents,
             o.tax_cents, o.total_cents, o.refund_amount_cents, o.receipt_data,
             b.name as branch_name, b.organization_id as branch_organization_id,
             u.organization_id as user_organization_id, u.branch_id as user_branch_id,
             r.id as refund_id, r.organization_id as refund_organization_id,
             r.amount_cents as refund_cents, r.tax_refund_cents, r.status as refund_status,
             r.refund_number, r.processed_by_user_id
      from legacy_order_imports loi
      join orders o on o.id = loi.order_id
      join branches b on b.id = o.branch_id
      join users u on u.id = o.created_by_user_id
      join refunds r on r.order_id = o.id
      where loi.organization_id = $1 and loi.source_system = $2 and loi.legacy_order_id = $3
    `, [KE_ORGANIZATION.id, LEGACY_SOURCE, LEGACY_ORDER_ID])
    check(imported.length === 1, `Expected one order-1100 import; found ${imported.length}`)
    const order = imported[0]

    if (order) {
      check(String(order.batch_id) === EXPECTED_BATCH_ID, "Order 1100 batch ID mismatch")
      check(order.source_checksum === expectedSourceChecksum, "Order 1100 source checksum mismatch")
      check(order.tid === "KE-LEGACY-1100", "Order 1100 TID mismatch")
      check(Number(order.organization_id) === 10 && Number(order.branch_organization_id) === 10, "Order/branch tenant mismatch")
      check(Number(order.branch_id) === 222 && order.branch_name === "IBC Malir", "Order 1100 branch mismatch")
      check(Number(order.user_organization_id) === 10 && Number(order.user_branch_id) === 222, "Order creator tenant/branch mismatch")
      check(order.status === "FULFILLED" && order.fulfillment_status === "DELIVERED" && order.payment_status === "UNPAID", "Order status mismatch")
      check(Number(order.subtotal_cents) === 3_719_000 && Number(order.tax_cents) === 0 && Number(order.total_cents) === 3_719_000, "Order financial mismatch")
      check(Number(order.refund_amount_cents) === 170_000, "Order refund amount mismatch")
      check(Number(order.refund_organization_id) === 10 && order.refund_status === "APPROVED", "Refund tenant/status mismatch")
      check(Number(order.refund_cents) === 170_000 && Number(order.tax_refund_cents) === 0 && order.refund_number === "KE-R-1100", "Refund financial/number mismatch")
      check(Number(order.receipt_data?.subtotal) === 37_190 && Number(order.receipt_data?.refund) === 1_700 && Number(order.receipt_data?.totalAmount) === 37_190, "Receipt totals mismatch")
      check(order.source_payload?.kind === "REFUND_AWARE" && order.source_payload?.sourceStatusPolicy === "LEGACY_TERMINAL_REFUND_STATUS", "Refund-aware source policy mismatch")
      check(Number(order.source_payload?.refundBreakdown?.itemRefundCents) === 170_000
        && Number(order.source_payload?.refundBreakdown?.taxRefundCents) === 0
        && Number(order.source_payload?.refundBreakdown?.grossRefundCents) === 170_000, "Source refund breakdown mismatch")
      const approvedMapping = order.source_payload?.header?.ApprovedProductMappings?.[0]
      check(approvedMapping?.sourceProduct === SOURCE_PRODUCT
        && approvedMapping?.targetProduct === TARGET_PRODUCT
        && Number(approvedMapping?.targetGlobalProductId) === 238
        && Number(approvedMapping?.targetOrganizationInventoryId) === 248, "Approved mapping provenance mismatch")

      const items = await rows(client, `
        select oi.id, oi.product_name, oi.quantity, oi.price_cents,
               oi.global_product_id, oi.organization_inventory_id, oi.organization_id,
               gp.name as global_product_name, inv.organization_id as inventory_organization_id,
               bi.id as branch_inventory_id, bi.is_active as branch_inventory_active,
               bi.is_visible as branch_inventory_visible, bi.deleted_at as branch_inventory_deleted_at,
               coalesce(sum(ri.quantity), 0)::int as refunded_quantity,
               coalesce(sum(ri.amount_cents), 0)::bigint as item_refund_cents
        from order_items oi
        join global_products gp on gp.id = oi.global_product_id
        join organization_inventory inv on inv.id = oi.organization_inventory_id
        left join branch_inventory bi
          on bi.branch_id = $1 and bi.organization_id = $2
         and bi.organization_inventory_id = oi.organization_inventory_id and bi.deleted_at is null
        left join refund_items ri on ri.order_item_id = oi.id and ri.refund_id = $3
        where oi.order_id = $4 and oi.organization_id = $2
        group by oi.id, gp.name, inv.organization_id, bi.id, bi.is_active, bi.is_visible, bi.deleted_at
        order by oi.id
      `, [order.branch_id, KE_ORGANIZATION.id, order.refund_id, order.order_id])
      check(items.length === 16, `Expected 16 items; found ${items.length}`)
      check(items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.price_cents), 0) === 3_719_000, "Order-item subtotal mismatch")
      check(items.every((item) => Number(item.organization_id) === 10
        && Number(item.inventory_organization_id) === 10
        && item.branch_inventory_id != null), "Item tenant/branch assignment mismatch")
      const mapped = items.filter((item) => item.product_name === TARGET_PRODUCT)
      check(mapped.length === 1, `Expected one mapped Millac line; found ${mapped.length}`)
      if (mapped[0]) {
        check(Number(mapped[0].quantity) === 2 && Number(mapped[0].price_cents) === 159_000, "Mapped Millac quantity/unit price mismatch")
        check(Number(mapped[0].global_product_id) === 238 && Number(mapped[0].organization_inventory_id) === 248, "Mapped Millac target IDs mismatch")
        check(mapped[0].global_product_name === TARGET_PRODUCT, "Mapped global-product name mismatch")
      }
      check(items.every((item) => item.product_name !== SOURCE_PRODUCT), "Unmapped source product name leaked into order items")
      const refunded = items.filter((item) => Number(item.refunded_quantity) > 0)
      check(refunded.length === 1, `Expected one refunded item; found ${refunded.length}`)
      if (refunded[0]) {
        check(refunded[0].product_name === "Nestle Kashmiri Tea (500 GM)"
          && Number(refunded[0].quantity) === 1
          && Number(refunded[0].price_cents) === 170_000
          && Number(refunded[0].refunded_quantity) === 1
          && Number(refunded[0].item_refund_cents) === 170_000, "Refunded item mismatch")
      }

      const batchRows = await rows(client, "select id, status, source_manifest, counts, imported_by_user_id from legacy_import_batches where id = $1 and organization_id = $2", [order.batch_id, KE_ORGANIZATION.id])
      const batch = batchRows[0]
      check(batchRows.length === 1 && batch?.status === "COMPLETED", "Import batch missing/incomplete")
      check(batch?.source_manifest?.digest === expectedManifestDigest && batch?.source_manifest?.kind === "REFUND_AWARE_WITH_TAX_BREAKDOWN", "Batch manifest mismatch")
      check(Number(batch?.counts?.orders) === 1 && Number(batch?.counts?.orderItems) === 16
        && Number(batch?.counts?.refunds) === 1 && Number(batch?.counts?.refundItems) === 1
        && Number(batch?.counts?.newBranchAssignments) === 16 && Number(batch?.counts?.newUserMappings) === 1, "Batch counts mismatch")
      check(batch?.imported_by_user_id === order.processed_by_user_id, "Batch/refund actor mismatch")

      const createdAssignments = await rows(client, `
        select branch_id, organization_inventory_id, is_active, is_visible, deleted_at
        from branch_inventory
        where organization_id = $1 and branch_id = 222 and assigned_by_user_id = $2
          and organization_inventory_id = any($3::int[])
      `, [KE_ORGANIZATION.id, batch.imported_by_user_id, items.map((item) => Number(item.organization_inventory_id))])
      check(createdAssignments.length === 16, `Expected 16 IBC Malir assignments; found ${createdAssignments.length}`)
      check(createdAssignments.every((row) => row.is_active === false && row.is_visible === false && row.deleted_at === null), "Historical branch assignments are not inactive/hidden")

      const userMappings = await rows(client, `
        select legacy_order_taker_id, branch_id, source_name, is_synthetic, user_id
        from legacy_user_mappings where organization_id = $1 and source_system = $2 and created_by_batch_id = $3
      `, [KE_ORGANIZATION.id, LEGACY_SOURCE, order.batch_id])
      check(userMappings.length === 1
        && Number(userMappings[0]?.legacy_order_taker_id) === 138
        && Number(userMappings[0]?.branch_id) === 222
        && userMappings[0]?.source_name === "Shaikh Zeesan"
        && userMappings[0]?.is_synthetic === false
        && userMappings[0]?.user_id === order.created_by_user_id, "Legacy user mapping mismatch")

      const productIds = [...new Set(items.map((item) => Number(item.global_product_id)))].sort((a, b) => a - b)
      check(batch?.source_manifest?.operationalDigest === stableDigest(await operationalState(client, productIds)), "Operational ledger digest changed")
    }

    const excluded = await rows(client, `
      select
        (select count(*)::int from legacy_order_imports where organization_id = $1 and source_system = $2 and legacy_order_id = $3) as imports,
        (select count(*)::int from orders where organization_id = $1 and tid = $4) as orders,
        (select count(*)::int from refunds where organization_id = $1 and refund_number = $5) as refunds
    `, [KE_ORGANIZATION.id, LEGACY_SOURCE, EXCLUDED_ORDER_ID, "KE-LEGACY-192", "KE-R-192"])
    check(Number(excluded[0]?.imports) === 0 && Number(excluded[0]?.orders) === 0 && Number(excluded[0]?.refunds) === 0, "Order 192 was imported or otherwise created")

    const counts = await rows(client, "select count(*)::int as count from legacy_order_imports where organization_id = $1 and source_system = $2", [KE_ORGANIZATION.id, LEGACY_SOURCE])
    check(Number(counts[0]?.count) === 707, `Expected 707 imported legacy orders; found ${counts[0]?.count}`)
    await client.query("commit")

    const result = {
      generatedAt: new Date().toISOString(),
      status: failures.length === 0 ? "PASS" : "FAILED",
      organization: KE_ORGANIZATION,
      legacyOrderId: LEGACY_ORDER_ID,
      batchId: order?.batch_id ?? null,
      importedOrderId: order?.order_id == null ? null : Number(order.order_id),
      expectedManifestDigest,
      approvedMapping: { sourceProduct: SOURCE_PRODUCT, targetProduct: TARGET_PRODUCT, globalProductId: 238, organizationInventoryId: 248 },
      order192Untouched: Number(excluded[0]?.imports) === 0 && Number(excluded[0]?.orders) === 0 && Number(excluded[0]?.refunds) === 0,
      importedLegacyOrders: Number(counts[0]?.count),
      failures,
    }
    if (output) writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
    console.log(JSON.stringify({ output, ...result }, null, 2))
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
  console.error(error)
  process.exit(1)
})
