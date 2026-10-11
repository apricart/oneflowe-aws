#!/usr/bin/env tsx
/**
 * The invoice number register (plans/OF-INVOICE-invoice-ledger.md, D6):
 * every number each organization's series has drawn, and what became of it.
 *
 * Before invoices were numbered at delivery, a number was drawn when an order
 * was placed, so rejected, cancelled and deleted orders left gaps in the
 * series. This report explains each one for the accountant and auditors.
 * Read-only: it writes a CSV and prints a summary, and changes nothing.
 *
 *   npx tsx scripts/report-invoice-number-register.ts [--organization-id=<id>] [--output=<file>.csv]
 *
 * Fates: ISSUED (a tax invoice exists), RESERVED (approved, not yet delivered),
 * PENDING (awaiting approval), NOT_ISSUED_<STATUS> (the order was rejected,
 * cancelled or refunded before delivery), DELETED (the order was deleted; its
 * DELETE_ORDER audit row names the number), UNACCOUNTED (no surviving record —
 * in practice orders deleted before 2026-09-26, when deletions were first
 * audited). The output names customers, so it goes to the gitignored
 * updatedReports/ by default.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"

import { classifyRegisteredNumber, registerNumberCandidates, type RegisterOrder } from "../lib/invoice-number-register"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

function arg(name: string): string | undefined {
  const prefix = `--${name}=`
  const inline = process.argv.find((value) => value.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}

function describeTarget(): string {
  try {
    const url = new URL(process.env.DATABASE_URL ?? "")
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`
  } catch {
    return "(DATABASE_URL is not a URL)"
  }
}

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value)
  // Neutralise spreadsheet formulas and quote every cell.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}

async function main(): Promise<void> {
  const { closePool, pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    console.log(`[invoice-number-register] target: ${describeTarget()}`)
    const organizationFilter = arg("organization-id")
    const { rows: organizations } = await client.query(`
      select org.id, org.name, org.code, s.last_value
        from invoice_sequences s join organizations org on org.id = s.organization_id
       where ($1::int is null or org.id = $1::int)
       order by org.id
    `, [organizationFilter ? Number(organizationFilter) : null])

    const lines = [["organization_id", "organization", "sequence", "number", "fate", "order_id", "order_status", "invoice_issue_date", "detail"].map(csvCell).join(",")]
    const summary: Record<string, Record<string, number>> = {}

    for (const organization of organizations) {
      const organizationId = Number(organization.id)
      const { rows: orderRows } = await client.query(`
        select o.id, o.status, o.fulfillment_status, o.status_at_refund,
               o.receipt_data ->> 'invoiceNumber' as number, i.issue_date
          from orders o left join invoices i on i.order_id = o.id
         where o.organization_id = $1 and o.receipt_data ->> 'invoiceNumber' is not null
      `, [organizationId])
      const { rows: deletions } = await client.query(`
        select entity_id, metadata -> 'before' ->> 'invoiceNumber' as number, created_at
          from audit_logs
         where action = 'DELETE_ORDER' and organization_id = $1
      `, [organizationId])

      const orderByNumber = new Map<string, RegisterOrder>()
      for (const row of orderRows) {
        orderByNumber.set(String(row.number), {
          orderId: Number(row.id),
          status: row.status,
          fulfillmentStatus: row.fulfillment_status,
          statusAtRefund: row.status_at_refund,
          invoiceIssueDate: row.issue_date ? String(row.issue_date).slice(0, 10) : null,
        })
      }
      const deletedByNumber = new Map<string, { orderId: string; deletedAt: string }>()
      for (const row of deletions) {
        if (row.number) deletedByNumber.set(String(row.number), { orderId: String(row.entity_id), deletedAt: new Date(row.created_at).toISOString() })
      }

      const counts: Record<string, number> = {}
      for (let sequence = 1; sequence <= Number(organization.last_value); sequence += 1) {
        const candidates = registerNumberCandidates(String(organization.code ?? ""), sequence)
        const entry = classifyRegisteredNumber(candidates, orderByNumber, deletedByNumber)
        counts[entry.fate] = (counts[entry.fate] ?? 0) + 1
        lines.push([
          organizationId, organization.name, sequence, entry.number, entry.fate, entry.orderId ?? "",
          entry.orderStatus ?? "", entry.invoiceIssueDate ?? "", entry.detail ?? "",
        ].map(csvCell).join(","))
      }
      summary[`${organizationId} ${organization.name}`] = counts
    }

    const output = resolve(process.cwd(),
      arg("output") ?? `updatedReports/invoice-number-register-${new Date().toISOString().slice(0, 10)}.csv`)
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 })
    console.log(JSON.stringify({ mode: "READ_ONLY", output, summary }, null, 2))
  } finally {
    client.release()
    await closePool()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
