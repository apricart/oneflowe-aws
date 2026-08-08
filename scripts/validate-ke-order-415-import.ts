#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { PoolClient } from "pg"

import { pool } from "../lib/db-cli"
import { KE_ORGANIZATION, LEGACY_SOURCE, prepareKeLegacySource } from "../lib/legacy-import/ke-electric"

type Row = Record<string, any>

const SOURCE_ROOT = resolve("updatedReports/ke-order-415-missing-values-zero-2026-08-05/reports")
const LEGACY_ORDER_ID = 415
const EXPECTED_ITEMS = [
  { name: "Nestle Everyday (1 KG)", quantity: 3, priceCents: 204_000 },
  { name: "Nescafe Classic Coffee (100 GM)", quantity: 1, priceCents: 210_000 },
] as const

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
  const expectedOrder = source.prepared[0]
  if (source.prepared.length !== 1 || expectedOrder?.legacyOrderId !== LEGACY_ORDER_ID || source.rejected.length !== 0) {
    throw new Error("Order 415 prepared-source validation failed")
  }
  const expectedDigest = manifestDigest(source.manifest)
  const failures: string[] = []
  const check = (condition: unknown, message: string) => { if (!condition) failures.push(message) }
  const client = await pool.connect()
  try {
    await client.query("begin transaction isolation level repeatable read read only")
    const imported = await rows(client, `
      select loi.legacy_order_id, loi.source_checksum, loi.source_payload, loi.batch_id,
             o.id as order_id, o.tid, o.organization_id, o.branch_id, o.status,
             o.fulfillment_status, o.payment_status, o.subtotal_cents, o.tax_cents,
             o.total_cents, o.refund_amount_cents, o.receipt_data,
             b.organization_id as branch_organization_id, b.name as branch_name,
             u.organization_id as user_organization_id, u.branch_id as user_branch_id
      from legacy_order_imports loi
      join orders o on o.id = loi.order_id
      join branches b on b.id = o.branch_id
      join users u on u.id = o.created_by_user_id
      where loi.organization_id = $1 and loi.source_system = $2 and loi.legacy_order_id = $3
    `, [KE_ORGANIZATION.id, LEGACY_SOURCE, LEGACY_ORDER_ID])
    check(imported.length === 1, `Expected one imported ledger row; found ${imported.length}`)
    const order = imported[0]
    if (order) {
      check(order.source_checksum === expectedOrder.sourceChecksum, "Source checksum mismatch")
      check(order.tid === "KE-LEGACY-415", "TID mismatch")
      check(Number(order.organization_id) === 10 && Number(order.branch_organization_id) === 10 && order.branch_name === "GSMP North", "Order/branch tenant mismatch")
      check(Number(order.user_organization_id) === 10 && Number(order.user_branch_id) === Number(order.branch_id), "Creator tenant/branch mismatch")
      check(order.status === "FULFILLED" && order.fulfillment_status === "DELIVERED" && order.payment_status === "UNPAID", "Order status mismatch")
      check(Number(order.subtotal_cents) === 822_000 && Number(order.tax_cents) === 0 && Number(order.total_cents) === 822_000, "Order financial mismatch")
      check(Number(order.refund_amount_cents ?? 0) === 0, "Unexpected refund amount")
      check(order.source_payload?.sourceHeader?.OriginalStatusID === 1 && order.source_payload?.sourceHeader?.OriginalDeliveryStatus === 507, "Original status provenance mismatch")
      check(order.source_payload?.sourceHeader?.MigrationStatusPolicy === "USER_APPROVED_OLD_NON_REFUND_AS_DELIVERED", "Delivered-policy provenance mismatch")
      check(order.source_payload?.sourceHeader?.FinancialValuesPolicy === "USER_APPROVED_MISSING_VALUES_AS_ZERO", "Missing-value policy provenance mismatch")
      check(order.source_payload?.sourceHeader?.DerivedSubtotalPolicy === "SUM_VERIFIED_ITEM_LINES", "Subtotal policy provenance mismatch")
      check(order.source_payload?.sourceHeader?.AssumedMissingValues?.Tax === 0 && order.source_payload?.sourceHeader?.AssumedMissingValues?.RefundAmount === 0, "Zero-value provenance mismatch")
      check(Number(order.receipt_data?.subtotal) === 8220 && Number(order.receipt_data?.tax) === 0 && Number(order.receipt_data?.totalAmount) === 8220, "Receipt totals mismatch")

      const items = await rows(client, `
        select oi.product_name, oi.quantity, oi.price_cents, oi.global_product_id,
               oi.organization_inventory_id, oi.organization_id,
               bi.id as branch_inventory_id
        from order_items oi
        left join branch_inventory bi
          on bi.branch_id = $1 and bi.organization_id = $2
         and bi.organization_inventory_id = oi.organization_inventory_id
         and bi.deleted_at is null
        where oi.order_id = $3 and oi.organization_id = $2
        order by oi.id
      `, [order.branch_id, KE_ORGANIZATION.id, order.order_id])
      check(items.length === EXPECTED_ITEMS.length, `Expected ${EXPECTED_ITEMS.length} items; found ${items.length}`)
      check(items.every((item) => Number(item.quantity) > 0 && Number(item.price_cents) > 0), "Non-positive item found")
      check(items.reduce((sum, item) => sum + Math.round(Number(item.quantity) * Number(item.price_cents)), 0) === 822_000, "Imported item subtotal mismatch")
      check(items.every((item) => Number(item.organization_id) === 10 && item.branch_inventory_id != null), "Item tenant/branch assignment mismatch")
      for (const expected of EXPECTED_ITEMS) {
        const matches = items.filter((item) => item.product_name === expected.name)
        check(matches.length === 1, `${expected.name} row count mismatch`)
        if (matches[0]) check(Number(matches[0].quantity) === expected.quantity && Number(matches[0].price_cents) === expected.priceCents, `${expected.name} quantity/price mismatch`)
      }
      const refundCount = await rows(client, "select count(*)::int as count from refunds where order_id = $1 and organization_id = $2", [order.order_id, KE_ORGANIZATION.id])
      check(Number(refundCount[0]?.count) === 0, "Unexpected refund row")

      const batchRows = await rows(client, "select status, source_manifest, counts from legacy_import_batches where id = $1 and organization_id = $2", [order.batch_id, KE_ORGANIZATION.id])
      const batch = batchRows[0]
      check(batchRows.length === 1 && batch?.status === "COMPLETED", "Import batch missing or incomplete")
      check(batch?.source_manifest?.digest === expectedDigest, "Import batch manifest digest mismatch")
      check(Number(batch?.counts?.orders) === 1 && Number(batch?.counts?.newProducts) === 0 && Number(batch?.counts?.newHistoricalUsers) === 0, "Import batch counts mismatch")
    }
    const countRows = await rows(client, "select count(*)::int as count from legacy_order_imports where organization_id = $1 and source_system = $2", [KE_ORGANIZATION.id, LEGACY_SOURCE])
    check(Number(countRows[0]?.count) === 706, `Expected 706 imported legacy orders; found ${countRows[0]?.count}`)
    await client.query("commit")

    const result = {
      generatedAt: new Date().toISOString(),
      status: failures.length === 0 ? "PASS" : "FAILED",
      organization: KE_ORGANIZATION,
      legacyOrderId: LEGACY_ORDER_ID,
      expectedManifestDigest: expectedDigest,
      importedOrderId: order?.order_id == null ? null : Number(order.order_id),
      batchId: order?.batch_id == null ? null : String(order.batch_id),
      importedItems: order ? EXPECTED_ITEMS.length : 0,
      importedLegacyOrders: Number(countRows[0]?.count),
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
