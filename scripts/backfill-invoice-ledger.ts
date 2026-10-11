#!/usr/bin/env tsx
/**
 * Copy every invoice supplied before the invoice ledger existed into it
 * (plans/OF-INVOICE-invoice-ledger.md, D6).
 *
 * Which orders qualify, and the row each becomes, is pure and unit-tested in
 * `lib/invoice-ledger-backfill.ts`. This script reads rows, gates the write
 * behind the printed plan digest, and records what it did.
 *
 *   npx tsx scripts/backfill-invoice-ledger.ts                      # dry run
 *   npx tsx scripts/backfill-invoice-ledger.ts --commit \
 *     --confirm-plan-sha256=<digest> --expected-rows=<n> --operator=you@example.com
 *   npx tsx scripts/backfill-invoice-ledger.ts --validate           # read-only check
 *   npx tsx scripts/backfill-invoice-ledger.ts --rollback --batch=<batch> \
 *     --confirm-rollback=ROLLBACK:<batch>
 *
 * Run order: apply the migration, run this (dry run, then commit), deploy, and
 * run it once more — an order delivered between the backfill and the deploy is
 * picked up by the second run, and a run with nothing to do commits nothing.
 *
 * What it writes: `invoices` rows only (origin LEGACY_*, `backfill_batch` set),
 * and one `audit_logs` row per commit or rollback.
 *
 * What it will not do: renumber, redate or reprice anything; create a credit
 * note; touch an order, an invoice issued at supply, or a row another batch
 * wrote. Rollback can delete only rows carrying its own batch, and the
 * database refuses it for any invoice a credit note has since been issued on.
 *
 * It connects with DATABASE_URL (lib/db-cli). Check the printed target before
 * committing.
 */

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"

import {
  backfillDigestInput,
  planLegacyInvoice,
  summarizeLegacyBackfill,
  type LegacyInvoicePlan,
  type LegacyInvoiceSource,
} from "../lib/invoice-ledger-backfill"
import { INVOICE_ISSUER } from "../lib/invoice-issuer"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ADVISORY_LOCK = 700021
const AUDIT_ACTION = "BACKFILL_INVOICE_LEDGER"
const ROLLBACK_AUDIT_ACTION = "ROLLBACK_INVOICE_LEDGER_BACKFILL"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`
  const inline = process.argv.find((value) => value.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}

const flag = (name: string) => process.argv.includes(`--${name}`)
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 })
}

function describeTarget(): string {
  try {
    const url = new URL(process.env.DATABASE_URL ?? "")
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`
  } catch {
    return "(DATABASE_URL is not a URL)"
  }
}

async function readSources(client: PoolClient): Promise<LegacyInvoiceSource[]> {
  const { rows } = await client.query(`
    select o.id, o.tid, o.organization_id, o.branch_id, o.status, o.fulfillment_status,
           o.status_at_refund, o.refund_amount_cents, o.subtotal_cents, o.tax_cents, o.total_cents,
           o.receipt_data, o.created_at, o.delivered_at, o.fulfilled_at,
           org.name as organization_name, org.code as organization_code,
           org.ntn_number, org.strn_number, b.name as branch_name, b.cost_center_id,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'amountCents', r.amount_cents,
               'taxRefundCents', r.tax_refund_cents,
               'lines', coalesce((
                 select jsonb_agg(jsonb_build_object('grossCents', ri.amount_cents, 'taxRateBp', oi.tax_rate_bp) order by ri.id)
                   from refund_items ri join order_items oi on oi.id = ri.order_item_id
                  where ri.refund_id = r.id
               ), '[]'::jsonb)
             ) order by r.id)
               from refunds r
              where r.order_id = o.id and upper(r.status) in ('APPROVED', 'COMPLETED')
           ), '[]'::jsonb) as approved_refunds
      from orders o
      left join organizations org on org.id = o.organization_id
      left join branches b on b.id = o.branch_id and b.organization_id = o.organization_id
     where o.receipt_data is not null
       and not exists (select 1 from invoices i where i.order_id = o.id)
     order by o.id
  `)
  return rows.map((row) => ({
    orderId: Number(row.id),
    tid: String(row.tid),
    organizationId: row.organization_id === null ? null : Number(row.organization_id),
    branchId: Number(row.branch_id),
    status: row.status,
    fulfillmentStatus: row.fulfillment_status,
    statusAtRefund: row.status_at_refund,
    refundAmountCents: row.refund_amount_cents === null ? null : Number(row.refund_amount_cents),
    subtotalCents: Number(row.subtotal_cents),
    taxCents: Number(row.tax_cents),
    totalCents: Number(row.total_cents),
    receiptData: row.receipt_data,
    createdAt: new Date(row.created_at),
    deliveredAt: row.delivered_at ? new Date(row.delivered_at) : null,
    fulfilledAt: row.fulfilled_at ? new Date(row.fulfilled_at) : null,
    organizationName: row.organization_name,
    organizationCode: row.organization_code,
    organizationNtn: row.ntn_number,
    organizationStrn: row.strn_number,
    branchName: row.branch_name,
    branchCostCenterId: row.cost_center_id,
    approvedRefunds: (row.approved_refunds as Array<{ amountCents: unknown; taxRefundCents: unknown; lines: Array<{ grossCents: unknown; taxRateBp: unknown }> }>)
      .map((refund) => ({
        amountCents: Number(refund.amountCents),
        taxRefundCents: Number(refund.taxRefundCents),
        lines: refund.lines.map((line) => ({
          grossCents: Number(line.grossCents),
          taxRateBp: line.taxRateBp === null ? null : Number(line.taxRateBp),
        })),
      })),
  }))
}

const planDigest = (plans: LegacyInvoicePlan[]) => sha256(JSON.stringify(backfillDigestInput(plans)))

async function insertPlan(client: PoolClient, plans: LegacyInvoicePlan[], batch: string): Promise<number> {
  const seller = JSON.stringify({
    name: INVOICE_ISSUER.name,
    addressLines: [...INVOICE_ISSUER.addressLines],
    ntn: INVOICE_ISSUER.ntn,
    strn: INVOICE_ISSUER.strn,
  })
  let inserted = 0
  for (const plan of plans) {
    if (plan.kind !== "insert") continue
    const { row } = plan
    await client.query(`
      insert into invoices (
        organization_id, branch_id, order_id, number, issue_date, issued_at, origin, status,
        seller, buyer, participants, net_cents, tax_cents, discount_cents, delivery_charges_cents,
        total_cents, credited_net_cents, credited_tax_cents, credited_total_cents,
        legacy_snapshot, issued_by_user_id, backfill_batch
      )
      select $1, $2, o.id, $4, $5::date, $6::timestamptz, $7, $8,
             $9::jsonb, $10::jsonb, '{}'::jsonb, $11, $12, 0, 0,
             $13, $14, $15, $16,
             o.receipt_data, null, $17
        from orders o
       where o.id = $3 and o.organization_id = $1
    `, [
      row.organizationId, row.branchId, row.orderId, row.number, row.issueDate, row.issuedAt,
      row.origin, row.status, seller, JSON.stringify(row.buyer), row.netCents, row.taxCents,
      row.totalCents, row.creditedNetCents, row.creditedTaxCents, row.creditedTotalCents, batch,
    ])
    inserted += 1
  }
  return inserted
}

async function validate(client: PoolClient): Promise<void> {
  const { rows: [counts] } = await client.query(`
    select
      (select count(*) from invoices) as invoices,
      (select count(*) from invoices where origin = 'ISSUED_AT_SUPPLY') as issued_at_supply,
      (select count(*) from invoices where origin <> 'ISSUED_AT_SUPPLY') as legacy,
      (select count(*) from orders o
         where o.receipt_data ->> 'invoiceNumber' is not null
           and (upper(o.fulfillment_status) = 'DELIVERED'
                or upper(o.status) in ('FULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED')
                or upper(coalesce(o.status_at_refund, '')) in ('FULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED'))
           and not exists (select 1 from invoices i where i.order_id = o.id)) as supplied_without_invoice
  `)
  const { rows: mismatches } = await client.query(`
    select i.id, i.order_id, i.number, o.receipt_data ->> 'invoiceNumber' as order_number,
           i.total_cents, o.total_cents as order_total_cents
      from invoices i join orders o on o.id = i.order_id
     where i.origin <> 'ISSUED_AT_SUPPLY'
       and (i.number is distinct from o.receipt_data ->> 'invoiceNumber' or i.total_cents <> o.total_cents)
     limit 50
  `)
  // A refund approved by code that predates the ledger (between the backfill
  // and the deploy) moves the order's refund total but not the invoice's
  // credited total. Legacy rows are compared with their order; invoices issued
  // at supply with the credit notes issued against them.
  const { rows: creditMismatches } = await client.query(`
    select i.id, i.order_id, i.number, i.origin, i.credited_total_cents,
           case when i.origin = 'ISSUED_AT_SUPPLY'
                then coalesce((select sum(c.total_cents) from credit_notes c where c.invoice_id = i.id), 0)
                else least(coalesce(o.refund_amount_cents, 0), i.total_cents) end as expected_credited_cents
      from invoices i join orders o on o.id = i.order_id
     where i.credited_total_cents <> case when i.origin = 'ISSUED_AT_SUPPLY'
                then coalesce((select sum(c.total_cents) from credit_notes c where c.invoice_id = i.id), 0)
                else least(coalesce(o.refund_amount_cents, 0), i.total_cents) end
     limit 50
  `)
  console.log(JSON.stringify({
    mode: "VALIDATE",
    target: describeTarget(),
    counts,
    legacyRowsDisagreeingWithTheirOrder: mismatches,
    creditedTotalsOutOfStep: creditMismatches,
  }, null, 2))
}

async function rollback(client: PoolClient): Promise<void> {
  const batch = arg("batch")
  assert(batch && /^[0-9a-f]{16}$/.test(batch), "Rollback requires --batch=<16-hex batch id from the commit report>")
  assert(arg("confirm-rollback") === `ROLLBACK:${batch}`, `Rollback requires --confirm-rollback=ROLLBACK:${batch}`)
  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
    // The trigger lets the rollback delete only rows this batch wrote.
    await client.query("select set_config('oneflowe.invoice_ledger_rollback_batch', $1, true)", [batch])
    const { rowCount } = await client.query("delete from invoices where backfill_batch = $1", [batch])
    await client.query(`
      insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
      values (null, null, null, $1, 'invoices', $2, $3::jsonb)
    `, [ROLLBACK_AUDIT_ACTION, batch, JSON.stringify({ batch, deleted: rowCount, operator: arg("operator") ?? null })])
    await client.query("commit")
    console.log(JSON.stringify({ mode: "ROLLED_BACK", target: describeTarget(), batch, deleted: rowCount }, null, 2))
  } catch (error) {
    await client.query("rollback")
    throw error
  }
}

async function main(): Promise<void> {
  const { closePool, pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    console.log(`[backfill-invoice-ledger] target: ${describeTarget()}`)
    if (flag("validate")) { await validate(client); return }
    if (flag("rollback")) { await rollback(client); return }

    const output = resolve(process.cwd(),
      arg("output") ?? `updatedReports/invoice-ledger-backfill-${new Date().toISOString().slice(0, 10)}.json`)
    const plans = (await readSources(client)).map(planLegacyInvoice)
    const digest = planDigest(plans)
    const summary = summarizeLegacyBackfill(plans)
    const report = {
      kind: "INVOICE_LEDGER_BACKFILL",
      target: describeTarget(),
      planSha256: digest,
      summary,
      rows: plans.filter((plan) => plan.kind === "insert").map((plan) => plan.kind === "insert" ? {
        orderId: plan.row.orderId, organizationId: plan.row.organizationId, number: plan.row.number,
        issueDate: plan.row.issueDate, status: plan.row.status, totalCents: plan.row.totalCents,
        creditedTotalCents: plan.row.creditedTotalCents,
      } : null),
      skipped: plans.filter((plan) => plan.kind === "skip" && plan.reason !== "NOT_SUPPLIED"),
    }

    if (!flag("commit")) {
      saveJson(output, { ...report, mode: "DRY_RUN" })
      console.log(JSON.stringify({ mode: "DRY_RUN", output, planSha256: digest, summary }, null, 2))
      if (summary.toInsert === 0) {
        console.log("\nNothing to backfill: every supplied invoice is already in the ledger.")
      } else {
        console.log("\nDry run: nothing was written. To apply:")
        console.log(`  npx tsx scripts/backfill-invoice-ledger.ts --commit \\
    --confirm-plan-sha256=${digest} --expected-rows=${summary.toInsert} --operator=<you@example.com>`)
      }
      return
    }

    const operator = arg("operator")
    assert(operator, "Commit requires --operator=<who is running this>")
    assert(arg("confirm-plan-sha256") === digest, `Commit requires --confirm-plan-sha256=${digest}`)
    assert(arg("expected-rows") === String(summary.toInsert), `Commit requires --expected-rows=${summary.toInsert}`)
    assert(summary.toInsert > 0, "Nothing to backfill")

    const batch = digest.slice(0, 16)
    let auditLogId = 0
    await client.query("begin")
    try {
      await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
      // Rebuilt from rows read under the lock: anything delivered, refunded or
      // invoiced since the dry run changes the digest, and nothing is written.
      const locked = (await readSources(client)).map(planLegacyInvoice)
      assert(planDigest(locked) === digest, "Orders changed after the dry run; run it again")
      const inserted = await insertPlan(client, locked, batch)
      assert(inserted === summary.toInsert, `Inserted ${inserted} rows, expected ${summary.toInsert}`)
      const { rows: [audit] } = await client.query(`
        insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
        values (null, null, null, $1, 'invoices', $2, $3::jsonb)
        returning id
      `, [AUDIT_ACTION, batch, JSON.stringify({ batch, planSha256: digest, operator, summary })])
      auditLogId = Number(audit.id)
      await client.query("commit")
    } catch (error) {
      await client.query("rollback")
      throw error
    }

    saveJson(output, {
      ...report,
      mode: "COMMITTED",
      committedAt: new Date().toISOString(),
      operator,
      batch,
      auditLogId,
      rollbackConfirmation: `ROLLBACK:${batch}`,
    })
    console.log(JSON.stringify({
      mode: "COMMITTED", output, batch, auditLogId, inserted: summary.toInsert,
      rollback: `npx tsx scripts/backfill-invoice-ledger.ts --rollback --batch=${batch} --confirm-rollback=ROLLBACK:${batch}`,
    }, null, 2))
  } finally {
    client.release()
    await closePool()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
