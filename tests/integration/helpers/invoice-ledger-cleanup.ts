import { inArray, or, sql } from "drizzle-orm"

import { creditNoteLines, creditNotes, invoiceLines, invoices } from "@/db/schema"
import { db } from "@/lib/db"

/**
 * Remove the invoice ledger rows a suite's own fixtures produced, so the suite
 * can then delete its orders, order items and refunds as before.
 *
 * Issued documents are immutable: triggers refuse every delete, and
 * invoices.order_id / credit_notes.refund_id / *_lines.order_item_id hold the
 * rows they point at. The triggers make one exception — a database whose name
 * contains "test", with `oneflowe.invoice_ledger_test_cleanup` switched on for
 * the transaction (drizzle/20261015120000_add_invoice_ledger.sql). That is set
 * here, transaction-local, and never anywhere in application code.
 */
export async function purgeInvoiceLedger(scope: { organizationIds?: number[]; orderIds?: number[] }): Promise<void> {
  const organizationIds = (scope.organizationIds ?? []).filter((id) => Number.isSafeInteger(id))
  const orderIds = (scope.orderIds ?? []).filter((id) => Number.isSafeInteger(id))
  if (organizationIds.length === 0 && orderIds.length === 0) return

  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('oneflowe.invoice_ledger_test_cleanup', 'on', true)`)

    const invoiceScope = or(
      organizationIds.length > 0 ? inArray(invoices.organizationId, organizationIds) : undefined,
      orderIds.length > 0 ? inArray(invoices.orderId, orderIds) : undefined,
    )
    const invoiceIds = (await tx.select({ id: invoices.id }).from(invoices).where(invoiceScope)).map((row) => row.id)
    if (invoiceIds.length === 0) return

    const creditNoteIds = (await tx.select({ id: creditNotes.id }).from(creditNotes)
      .where(inArray(creditNotes.invoiceId, invoiceIds))).map((row) => row.id)
    if (creditNoteIds.length > 0) {
      await tx.delete(creditNoteLines).where(inArray(creditNoteLines.creditNoteId, creditNoteIds))
      await tx.delete(creditNotes).where(inArray(creditNotes.id, creditNoteIds))
    }
    await tx.delete(invoiceLines).where(inArray(invoiceLines.invoiceId, invoiceIds))
    await tx.delete(invoices).where(inArray(invoices.id, invoiceIds))
  })
}
