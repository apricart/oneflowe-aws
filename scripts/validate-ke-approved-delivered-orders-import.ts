#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { PoolClient } from "pg"

import { pool } from "../lib/db-cli"
import { KE_ORGANIZATION, LEGACY_SOURCE, prepareKeLegacySource } from "../lib/legacy-import/ke-electric"

type Row = Record<string, any>

const SOURCE_ROOT = resolve("updatedReports/ke-approved-delivered-orders-41-51-53-87-1155-2026-08-05/reports")
const BATCH_ID = "25563074-24f0-471f-9d6b-32fd06e4d9e4"
const EXPECTED = [
  { id: 41, branchId: 133, branch: "KE HOUSE", items: 1, subtotal: 11_800, tax: 2_124, total: 13_924, originalStatus: 9, originalDelivery: 506, policy: "USER_APPROVED_OUT_FOR_DELIVERY_AS_DELIVERED" },
  { id: 51, branchId: 137, branch: "IT DEPARTMENT", items: 7, subtotal: 1_025_000, tax: 184_500, total: 1_209_500, originalStatus: 9, originalDelivery: 506, policy: "USER_APPROVED_OUT_FOR_DELIVERY_AS_DELIVERED" },
  { id: 53, branchId: 133, branch: "KE HOUSE", items: 1, subtotal: 71_500, tax: 12_870, total: 84_370, originalStatus: 9, originalDelivery: 506, policy: "USER_APPROVED_OUT_FOR_DELIVERY_AS_DELIVERED" },
  { id: 87, branchId: 136, branch: "ACCOUNT PAYABLE", items: 2, subtotal: 53_100, tax: 9_558, total: 62_658, originalStatus: 9, originalDelivery: 506, policy: "USER_APPROVED_OUT_FOR_DELIVERY_AS_DELIVERED" },
  { id: 1155, branchId: 183, branch: "NCSD", items: 11, subtotal: 5_429_500, tax: 0, total: 5_429_500, originalStatus: 2, originalDelivery: 503, policy: "USER_APPROVED_IN_PROCESS_AS_DELIVERED" },
] as const
const EXCLUDED_IDS = [173, 174, 177, 192, 1168, 1169, 1170, 1171, 1172, 1173, 1184]

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function manifestDigest(manifest: Record<string, { sha256: string }>): string {
  const stable = Object.entries(manifest)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, file]) => `${name}:${file.sha256}`)
    .join("\n")
  return createHash("sha256").update(stable).digest("hex")
}

async function rows(client: PoolClient, text: string, params: unknown[] = []): Promise<Row[]> {
  return (await client.query(text, params)).rows
}

async function main() {
  const output = arg("--output") ? resolve(arg("--output")!) : undefined
  const source = prepareKeLegacySource(SOURCE_ROOT)
  const expectedIds = EXPECTED.map((order) => order.id)
  const expectedManifestDigest = manifestDigest(source.manifest)
  const failures: string[] = []
  const check = (condition: unknown, message: string) => { if (!condition) failures.push(message) }
  check(source.rejected.length === 0, `Prepared source has ${source.rejected.length} rejections`)
  check(JSON.stringify(source.prepared.map((order) => order.legacyOrderId)) === JSON.stringify(expectedIds), "Prepared source IDs changed")

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
             u.is_active as user_is_active, u.deleted_at as user_deleted_at,
             ur.name as user_role_name
      from legacy_order_imports loi
      join orders o on o.id = loi.order_id
      join branches b on b.id = o.branch_id
      join users u on u.id = o.created_by_user_id
      join roles ur on ur.id = u.role_id
      where loi.organization_id = $1 and loi.source_system = $2
        and loi.legacy_order_id = any($3::int[])
      order by loi.legacy_order_id
    `, [KE_ORGANIZATION.id, LEGACY_SOURCE, expectedIds])
    check(imported.length === EXPECTED.length, `Expected five imported orders; found ${imported.length}`)
    check(new Set(imported.map((row) => String(row.batch_id))).size === 1
      && imported.every((row) => String(row.batch_id) === BATCH_ID), "Orders were not imported in the expected atomic batch")

    for (const expected of EXPECTED) {
      const found = imported.filter((row) => Number(row.legacy_order_id) === expected.id)
      check(found.length === 1, `Order ${expected.id} import row count is ${found.length}`)
      const row = found[0]
      const prepared = source.prepared.find((order) => order.legacyOrderId === expected.id)
      if (!row || !prepared) continue
      check(row.source_checksum === prepared.sourceChecksum, `Order ${expected.id} source checksum mismatch`)
      check(row.tid === `KE-LEGACY-${expected.id}`, `Order ${expected.id} TID mismatch`)
      check(Number(row.organization_id) === 10 && Number(row.branch_organization_id) === 10, `Order ${expected.id} tenant mismatch`)
      check(Number(row.branch_id) === expected.branchId && row.branch_name === expected.branch, `Order ${expected.id} branch mismatch`)
      check(Number(row.user_organization_id) === 10
        && Number(row.user_branch_id) === expected.branchId
        && row.user_role_name === "ORDER_PORTAL"
        && row.user_deleted_at === null, `Order ${expected.id} creator tenant/branch/role mismatch`)
      const creatorMappings = await rows(client, `
        select is_synthetic from legacy_user_mappings
        where organization_id = $1 and source_system = $2
          and legacy_order_taker_id = $3 and branch_id = $4 and user_id = $5
      `, [KE_ORGANIZATION.id, LEGACY_SOURCE, Number(prepared.sourceHeader.OrderTakerID), expected.branchId, row.created_by_user_id])
      check(creatorMappings.length === 1
        && (row.user_is_active === true || creatorMappings[0]?.is_synthetic === true), `Order ${expected.id} creator mapping mismatch`)
      check(row.status === "FULFILLED" && row.fulfillment_status === "DELIVERED" && row.payment_status === "UNPAID", `Order ${expected.id} target status mismatch`)
      check(Number(row.subtotal_cents) === expected.subtotal
        && Number(row.tax_cents) === expected.tax
        && Number(row.total_cents) === expected.total
        && Number(row.refund_amount_cents ?? 0) === 0, `Order ${expected.id} financial mismatch`)
      check(Number(row.receipt_data?.subtotal) === expected.subtotal / 100
        && Number(row.receipt_data?.tax) === expected.tax / 100
        && Number(row.receipt_data?.totalAmount) === expected.total / 100
        && Number(row.receipt_data?.refund) === 0, `Order ${expected.id} receipt mismatch`)
      check(Number(row.source_payload?.sourceHeader?.OriginalStatusID) === expected.originalStatus
        && Number(row.source_payload?.sourceHeader?.OriginalDeliveryStatus) === expected.originalDelivery
        && row.source_payload?.sourceHeader?.MigrationStatusPolicy === expected.policy
        && row.source_payload?.sourceHeader?.DeliveredPolicyApproval === "USER_EXPLICITLY_APPROVED_IMPORT_ON_2026-08-05", `Order ${expected.id} delivered-policy provenance mismatch`)

      const items = await rows(client, `
        select oi.product_name, oi.quantity, oi.price_cents, oi.global_product_id,
               oi.organization_inventory_id, oi.organization_id,
               inv.organization_id as inventory_organization_id,
               bi.id as branch_inventory_id, bi.is_active as branch_inventory_active,
               bi.is_visible as branch_inventory_visible, bi.deleted_at as branch_inventory_deleted_at
        from order_items oi
        join organization_inventory inv on inv.id = oi.organization_inventory_id
        left join branch_inventory bi
          on bi.branch_id = $1 and bi.organization_id = $2
         and bi.organization_inventory_id = oi.organization_inventory_id and bi.deleted_at is null
        where oi.order_id = $3 and oi.organization_id = $2
        order by oi.id
      `, [row.branch_id, KE_ORGANIZATION.id, row.order_id])
      check(items.length === expected.items, `Order ${expected.id} item count mismatch`)
      check(items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.price_cents), 0) === expected.subtotal, `Order ${expected.id} item subtotal mismatch`)
      check(items.every((item) => Number(item.organization_id) === 10
        && Number(item.inventory_organization_id) === 10
        && item.branch_inventory_id != null
        && Number(item.quantity) > 0
        && Number(item.price_cents) > 0), `Order ${expected.id} item tenant/assignment/value mismatch`)
      const refundCount = await rows(client, "select count(*)::int as count from refunds where organization_id = $1 and order_id = $2", [KE_ORGANIZATION.id, row.order_id])
      check(Number(refundCount[0]?.count) === 0, `Order ${expected.id} unexpectedly has a refund`)
    }

    const batchRows = await rows(client, "select status, source_manifest, counts, imported_by_user_id from legacy_import_batches where id = $1 and organization_id = $2", [BATCH_ID, KE_ORGANIZATION.id])
    const batch = batchRows[0]
    check(batchRows.length === 1 && batch?.status === "COMPLETED", "Import batch missing/incomplete")
    check(batch?.source_manifest?.digest === expectedManifestDigest, "Batch manifest digest mismatch")
    check(Number(batch?.counts?.orders) === 5
      && Number(batch?.counts?.products) === 19
      && Number(batch?.counts?.newProducts) === 1
      && Number(batch?.counts?.newHistoricalUsers) === 0, "Batch counts mismatch")

    const olpers = await rows(client, `
      select gp.id as global_product_id, gp.product_code, gp.name, gp.base_price_cents,
             gp.status, gp.stock_quantity, gp.deleted_at,
             inv.id as organization_inventory_id, inv.organization_id,
             inv.is_active as inventory_active, inv.custom_price_cents,
             lpm.normalized_name, lpm.source_name
      from legacy_product_mappings lpm
      join global_products gp on gp.id = lpm.global_product_id
      join organization_inventory inv on inv.id = lpm.organization_inventory_id
      where lpm.organization_id = $1 and lpm.source_system = $2 and lpm.normalized_name = 'olpers'
    `, [KE_ORGANIZATION.id, LEGACY_SOURCE])
    check(olpers.length === 1
      && olpers[0]?.name === "Olpers"
      && olpers[0]?.product_code === "PRD--176"
      && Number(olpers[0]?.base_price_cents) === 40_000
      && olpers[0]?.status === "inactive"
      && Number(olpers[0]?.stock_quantity) === 0
      && olpers[0]?.deleted_at === null
      && Number(olpers[0]?.organization_id) === 10
      && olpers[0]?.inventory_active === false
      && Number(olpers[0]?.custom_price_cents) === 40_000
      && olpers[0]?.source_name === "Olpers", "Historical-only Olpers product/mapping mismatch")

    const excluded = await rows(client, `
      select legacy_order_id from legacy_order_imports
      where organization_id = $1 and source_system = $2 and legacy_order_id = any($3::int[])
      order by legacy_order_id
    `, [KE_ORGANIZATION.id, LEGACY_SOURCE, EXCLUDED_IDS])
    check(excluded.length === 0, `Excluded orders were imported: ${excluded.map((row) => row.legacy_order_id).join(", ")}`)
    const counts = await rows(client, "select count(*)::int as count from legacy_order_imports where organization_id = $1 and source_system = $2", [KE_ORGANIZATION.id, LEGACY_SOURCE])
    check(Number(counts[0]?.count) === 712, `Expected 712 imported legacy orders; found ${counts[0]?.count}`)
    await client.query("commit")

    const result = {
      generatedAt: new Date().toISOString(),
      status: failures.length === 0 ? "PASS" : "FAILED",
      organization: KE_ORGANIZATION,
      batchId: BATCH_ID,
      importedLegacyOrderIds: imported.map((row) => Number(row.legacy_order_id)),
      importedOrderIds: imported.map((row) => Number(row.order_id)),
      expectedManifestDigest,
      excludedLegacyOrderIdsUntouched: excluded.length === 0,
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
