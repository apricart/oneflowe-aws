#!/usr/bin/env tsx

/** Read-only post-import validation for K-Electric legacy orders 43 and 44. */

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { PoolClient } from "pg"
import * as dotenv from "dotenv"

import { pool } from "../lib/db-cli"
import { KE_ORGANIZATION, LEGACY_SOURCE } from "../lib/legacy-import/ke-electric"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

type JsonRow = Record<string, any>

const EXPECTED = [
  {
    legacyOrderId: 43,
    status: "REFUNDED",
    subtotalCents: 64_500,
    taxCents: 11_610,
    totalCents: 76_110,
    itemRefundCents: 64_500,
    taxRefundCents: 11_610,
    grossRefundCents: 76_110,
    sourceStatusPolicy: "LEGACY_TERMINAL_REFUND_STATUS",
    items: [
      { sourceItemId: 3, name: "Spoon (6 Pcs)", quantity: 1, priceCents: 64_500, refundedQuantity: 1, refundCents: 64_500 },
    ],
  },
  {
    legacyOrderId: 44,
    status: "FULFILLED",
    subtotalCents: 24_400,
    taxCents: 4_392,
    totalCents: 28_792,
    itemRefundCents: 19_600,
    taxRefundCents: 3_528,
    grossRefundCents: 23_128,
    sourceStatusPolicy: "EXPLICITLY_APPROVED_AS_DELIVERED",
    items: [
      { sourceItemId: 71, name: "Nestle Juices (200 ML)", quantity: 1, priceCents: 7_800, refundedQuantity: 1, refundCents: 7_800 },
      { sourceItemId: 72, name: "Coke-Zero Can (250 ML)", quantity: 1, priceCents: 11_800, refundedQuantity: 1, refundCents: 11_800 },
      { sourceItemId: 70, name: "Nestle water (330ML)", quantity: 1, priceCents: 4_800, refundedQuantity: 0, refundCents: 0 },
    ],
  },
] as const

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

async function rows(client: PoolClient, text: string, params: unknown[] = []): Promise<JsonRow[]> {
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
  const reportPath = resolve(arg("--refund-report") ?? "updatedReports/ke-tax-refund-orders-43-44-source.json")
  const auditPath = resolve(arg("--refund-audit") ?? "updatedReports/ke-tax-refund-orders-43-44-evidence.json")
  const outputPath = arg("--output") ? resolve(arg("--output")!) : undefined
  const reportBuffer = readFileSync(reportPath)
  const auditBuffer = readFileSync(auditPath)
  const reportSource = JSON.parse(reportBuffer.toString("utf8")) as JsonRow[]
  const auditSource = JSON.parse(auditBuffer.toString("utf8")) as JsonRow
  const reportById = new Map(reportSource.map((row) => [Number(row.ID), row]))
  const detailById = new Map((auditSource.details as JsonRow[]).map((row) => [Number(row.reportOrderId), row]))
  const modalById = new Map((auditSource.refundModalEvidence.responses as JsonRow[]).map((row) => [Number(row.reportOrderId), row]))
  const evidenceById = new Map((auditSource.refundModalEvidence.orderEvidence as JsonRow[]).map((row) => [Number(row.reportOrderId), row]))
  const manifestFiles = [
    `refundAudit:${sha256(auditBuffer)}`,
    `refundReport:${sha256(reportBuffer)}`,
  ]
  const expectedManifestDigest = stableDigest({
    files: manifestFiles,
    approvedNonFinalLegacyOrderIds: [44],
    createMissingBranchAssignments: false,
  })

  const errors: string[] = []
  const client = await pool.connect()
  try {
    await client.query("begin transaction isolation level repeatable read read only")
    const imported = await rows(client, `
      select loi.legacy_order_id, loi.source_checksum, loi.source_payload, loi.batch_id,
             o.id as order_id, o.tid, o.organization_id, o.status, o.fulfillment_status,
             o.payment_status, o.subtotal_cents, o.tax_cents, o.total_cents,
             o.refund_amount_cents, o.receipt_data,
             r.id as refund_id, r.organization_id as refund_organization_id,
             r.amount_cents, r.tax_refund_cents, r.status as refund_status,
             r.refund_number
      from legacy_order_imports loi
      join orders o on o.id = loi.order_id
      join refunds r on r.order_id = o.id
      where loi.organization_id = $1 and loi.source_system = $2
        and loi.legacy_order_id = any($3::int[])
      order by loi.legacy_order_id
    `, [KE_ORGANIZATION.id, LEGACY_SOURCE, EXPECTED.map((order) => order.legacyOrderId)])
    if (imported.length !== EXPECTED.length) errors.push(`Expected ${EXPECTED.length} imported orders; found ${imported.length}`)

    const batchIds = [...new Set(imported.map((row) => String(row.batch_id)))]
    if (batchIds.length !== 1) errors.push(`Expected one atomic import batch; found ${batchIds.length}`)
    const batchRows = batchIds.length === 1
      ? await rows(client, "select id, status, source_manifest, counts from legacy_import_batches where id = $1 and organization_id = $2", [batchIds[0], KE_ORGANIZATION.id])
      : []
    const batch = batchRows[0]
    if (batch?.status !== "COMPLETED") errors.push("Import batch is missing or not completed")
    if (batch?.source_manifest?.digest !== expectedManifestDigest) errors.push("Import batch source manifest digest mismatch")
    if (JSON.stringify(batch?.source_manifest?.approvedNonFinalLegacyOrderIds) !== JSON.stringify([44])) {
      errors.push("Import batch does not contain the exact order-44 status approval")
    }
    if (batch?.source_manifest?.createMissingBranchAssignments !== false) {
      errors.push("Import batch did not preserve branch inventory by skipping missing assignments")
    }
    if (Number(batch?.counts?.newBranchAssignments ?? -1) !== 0 || Number(batch?.counts?.newUserMappings ?? -1) !== 0) {
      errors.push("Unexpected branch assignment or user mapping was created")
    }

    for (const expected of EXPECTED) {
      const found = imported.filter((row) => Number(row.legacy_order_id) === expected.legacyOrderId)
      if (found.length !== 1) {
        errors.push(`Order ${expected.legacyOrderId} import row count is ${found.length}`)
        continue
      }
      const row = found[0]
      const sourceChecksum = stableDigest({
        header: reportById.get(expected.legacyOrderId),
        detail: detailById.get(expected.legacyOrderId),
        modal: modalById.get(expected.legacyOrderId),
        evidence: evidenceById.get(expected.legacyOrderId),
      })
      if (row.source_checksum !== sourceChecksum) errors.push(`Order ${expected.legacyOrderId} source checksum mismatch`)
      if (row.tid !== `KE-LEGACY-${expected.legacyOrderId}` || Number(row.organization_id) !== KE_ORGANIZATION.id
        || Number(row.refund_organization_id) !== KE_ORGANIZATION.id) errors.push(`Order ${expected.legacyOrderId} tenant/TID mismatch`)
      if (row.status !== expected.status || row.fulfillment_status !== "DELIVERED" || row.payment_status !== "UNPAID") {
        errors.push(`Order ${expected.legacyOrderId} status mismatch`)
      }
      if (Number(row.subtotal_cents) !== expected.subtotalCents || Number(row.tax_cents) !== expected.taxCents
        || Number(row.total_cents) !== expected.totalCents || Number(row.refund_amount_cents) !== expected.grossRefundCents) {
        errors.push(`Order ${expected.legacyOrderId} financial mismatch`)
      }
      if (Number(row.amount_cents) !== expected.grossRefundCents || Number(row.tax_refund_cents) !== expected.taxRefundCents
        || row.refund_status !== "APPROVED" || row.refund_number !== `KE-R-${expected.legacyOrderId}`) {
        errors.push(`Order ${expected.legacyOrderId} refund header mismatch`)
      }
      if (Number(row.receipt_data?.refund) !== expected.grossRefundCents / 100
        || Number(row.receipt_data?.tax) !== expected.taxCents / 100
        || Number(row.receipt_data?.totalAmount) !== expected.totalCents / 100) {
        errors.push(`Order ${expected.legacyOrderId} receipt mismatch`)
      }
      if (row.source_payload?.sourceStatusPolicy !== expected.sourceStatusPolicy
        || Number(row.source_payload?.refundBreakdown?.itemRefundCents) !== expected.itemRefundCents
        || Number(row.source_payload?.refundBreakdown?.taxRefundCents) !== expected.taxRefundCents
        || Number(row.source_payload?.refundBreakdown?.grossRefundCents) !== expected.grossRefundCents) {
        errors.push(`Order ${expected.legacyOrderId} ledger refund breakdown mismatch`)
      }

      const itemRows = await rows(client, `
        select oi.product_name, oi.quantity, oi.price_cents,
               coalesce(sum(ri.quantity), 0) as refunded_quantity,
               coalesce(sum(ri.amount_cents), 0)::bigint as refund_cents,
               oi.global_product_id
        from order_items oi
        left join refund_items ri on ri.order_item_id = oi.id and ri.refund_id = $1
        where oi.order_id = $2 and oi.organization_id = $3
        group by oi.id, oi.product_name, oi.quantity, oi.price_cents, oi.global_product_id
        order by oi.id
      `, [row.refund_id, row.order_id, KE_ORGANIZATION.id])
      if (itemRows.length !== expected.items.length) errors.push(`Order ${expected.legacyOrderId} item count mismatch`)
      for (const expectedItem of expected.items) {
        const matchingItems = itemRows.filter((item) => item.product_name === expectedItem.name)
        if (matchingItems.length !== 1) {
          errors.push(`Order ${expected.legacyOrderId} item ${expectedItem.name} count mismatch`)
          continue
        }
        const item = matchingItems[0]
        if (Number(item.quantity) !== expectedItem.quantity || Number(item.price_cents) !== expectedItem.priceCents
          || Number(item.refunded_quantity) !== expectedItem.refundedQuantity || Number(item.refund_cents) !== expectedItem.refundCents) {
          errors.push(`Order ${expected.legacyOrderId} item ${expectedItem.name} value mismatch`)
        }
      }
      const itemRefundTotal = itemRows.reduce((sum, item) => sum + Number(item.refund_cents), 0)
      if (itemRefundTotal + Number(row.tax_refund_cents) !== Number(row.amount_cents)) {
        errors.push(`Order ${expected.legacyOrderId} item + tax refund does not equal gross refund`)
      }
    }

    const productIds = [...new Set((await rows(client, `
      select distinct oi.global_product_id
      from order_items oi join legacy_order_imports loi on loi.order_id = oi.order_id
      where loi.organization_id = $1 and loi.source_system = $2 and loi.legacy_order_id = any($3::int[])
      order by oi.global_product_id
    `, [KE_ORGANIZATION.id, LEGACY_SOURCE, EXPECTED.map((order) => order.legacyOrderId)])).map((row) => Number(row.global_product_id)))]
    const currentOperationalDigest = stableDigest(await operationalState(client, productIds))
    if (batch?.source_manifest?.operationalDigest !== currentOperationalDigest) {
      errors.push("Budget, quantity-budget, invoice-sequence, or relevant stock state changed from the import lock")
    }

    await client.query("commit")
    const result = {
      generatedAt: new Date().toISOString(),
      organization: KE_ORGANIZATION,
      expectedManifestDigest,
      batchId: batch?.id == null ? null : String(batch.id),
      validatedLegacyOrderIds: imported.map((row) => Number(row.legacy_order_id)),
      errors,
      ok: errors.length === 0,
    }
    if (outputPath) writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
    console.log(JSON.stringify(result, null, 2))
    if (errors.length > 0) process.exitCode = 1
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
