import "server-only"

import { and, eq, sql } from "drizzle-orm"

import {
  auditLogs,
  creditNoteLines,
  creditNotes,
  invoiceLines,
  invoices,
  orderItems,
  orders,
  refundItems,
  refunds,
} from "@/db/schema"
import { db } from "@/lib/db"
import {
  invoiceStatusAfterCredit,
  karachiDate,
  planCreditNote,
  refundTaxCents,
} from "@/lib/invoice-ledger"
import { generateNextCreditNoteNumber } from "@/lib/invoice-number"

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Refused inside a refund approval; the routes answer it as a 409. */
export const CREDIT_NOTE_CONFLICT_ERRORS = ["CREDIT_EXCEEDS_INVOICE", "CREDIT_LINES_EXCEED_REFUND"] as const

export type CreditNoteOutcome =
  | { kind: "issued"; creditNoteId: number; number: string; taxCents: number }
  | { kind: "no-invoice"; taxCents: number }
  | { kind: "exists"; creditNoteId: number }

/**
 * Issue the credit note for one refund that has just been approved
 * (plans/OF-INVOICE-invoice-ledger.md, D3).
 *
 * Called by both approval paths — Super Admin's direct refund and the approval
 * of a request — inside their own transaction, after the order row is locked
 * and the refund's lines are written, so the two paths cannot differ.
 *
 * When the order has a tax invoice the refund is credited against it with a
 * numbered credit note, and the invoice's credited totals and status move with
 * it. When it has none (the refund came before delivery) there is nothing to
 * credit: the invoice, when issued, is issued for what is left. Either way the
 * refund's tax part is recorded on `refunds.tax_refund_cents`.
 */
export async function issueCreditNoteForRefund(
  tx: Tx,
  input: { refundId: number; orderId: number; actor: { id: string; role: string }; reason: string | null | undefined },
): Promise<CreditNoteOutcome> {
  const [already] = await tx.select({ id: creditNotes.id }).from(creditNotes)
    .where(eq(creditNotes.refundId, input.refundId)).limit(1)
  if (already) return { kind: "exists", creditNoteId: already.id }

  const [refund] = await tx.select({ amountCents: refunds.amountCents, orderId: refunds.orderId })
    .from(refunds).where(eq(refunds.id, input.refundId)).limit(1)
  if (!refund || refund.orderId !== input.orderId) throw new Error("CREDIT_NOTE_REFUND_MISMATCH")
  const refundAmountCents = Number(refund.amountCents)

  const [invoice] = await tx.select({
    id: invoices.id,
    organizationId: invoices.organizationId,
    branchId: invoices.branchId,
    number: invoices.number,
    taxCents: invoices.taxCents,
    totalCents: invoices.totalCents,
    creditedTotalCents: invoices.creditedTotalCents,
  }).from(invoices).where(eq(invoices.orderId, input.orderId)).for("update").limit(1)

  const lines = await tx.select({
    orderItemId: refundItems.orderItemId,
    quantity: refundItems.quantity,
    grossCents: refundItems.amountCents,
    description: orderItems.productName,
    taxRateBp: orderItems.taxRateBp,
    invoiceLineId: invoiceLines.id,
  })
    .from(refundItems)
    .innerJoin(orderItems, eq(orderItems.id, refundItems.orderItemId))
    .leftJoin(invoiceLines, and(
      eq(invoiceLines.orderItemId, refundItems.orderItemId),
      invoice ? eq(invoiceLines.invoiceId, invoice.id) : sql`false`,
    ))
    .where(eq(refundItems.refundId, input.refundId))
    .orderBy(refundItems.id)

  if (!invoice) {
    const [order] = await tx.select({ taxCents: orders.taxCents, totalCents: orders.totalCents })
      .from(orders).where(eq(orders.id, input.orderId)).limit(1)
    const taxCents = refundTaxCents({
      refundAmountCents,
      lines: lines.map((line) => ({ grossCents: Number(line.grossCents), taxRateBp: line.taxRateBp })),
      order: { taxCents: Number(order?.taxCents ?? 0), totalCents: Number(order?.totalCents ?? 0) },
    })
    await tx.update(refunds).set({ taxRefundCents: taxCents }).where(eq(refunds.id, input.refundId))
    return { kind: "no-invoice", taxCents }
  }

  const plan = planCreditNote({
    refundAmountCents,
    lines: lines.map((line) => ({
      orderItemId: line.orderItemId,
      invoiceLineId: line.invoiceLineId,
      description: line.description,
      quantity: Number(line.quantity),
      grossCents: Number(line.grossCents),
      taxRateBp: line.taxRateBp,
    })),
    invoice: {
      taxCents: Number(invoice.taxCents),
      totalCents: Number(invoice.totalCents),
      creditedTotalCents: Number(invoice.creditedTotalCents),
    },
  })

  const number = await generateNextCreditNoteNumber(tx, invoice.organizationId)
  const issuedAt = new Date()
  const [creditNote] = await tx.insert(creditNotes).values({
    organizationId: invoice.organizationId,
    invoiceId: invoice.id,
    refundId: input.refundId,
    number,
    issueDate: karachiDate(issuedAt),
    issuedAt,
    reason: input.reason?.trim() || null,
    netCents: plan.netCents,
    taxCents: plan.taxCents,
    totalCents: plan.totalCents,
    issuedByUserId: input.actor.id,
  }).returning({ id: creditNotes.id })

  await tx.insert(creditNoteLines).values(plan.lines.map((line) => ({
    creditNoteId: creditNote.id,
    organizationId: invoice.organizationId,
    lineNo: line.lineNo,
    invoiceLineId: line.invoiceLineId,
    orderItemId: line.orderItemId,
    description: line.description,
    quantity: line.quantity,
    taxRateBp: line.taxRateBp,
    netCents: line.netCents,
    taxCents: line.taxCents,
    grossCents: line.grossCents,
  })))

  const creditedTotal = Number(invoice.creditedTotalCents) + plan.totalCents
  await tx.update(invoices).set({
    creditedNetCents: sql`${invoices.creditedNetCents} + ${plan.netCents}`,
    creditedTaxCents: sql`${invoices.creditedTaxCents} + ${plan.taxCents}`,
    creditedTotalCents: sql`${invoices.creditedTotalCents} + ${plan.totalCents}`,
    status: invoiceStatusAfterCredit(Number(invoice.totalCents), creditedTotal),
  }).where(eq(invoices.id, invoice.id))

  await tx.update(refunds).set({ taxRefundCents: plan.taxCents }).where(eq(refunds.id, input.refundId))

  await tx.insert(auditLogs).values({
    userId: input.actor.id,
    organizationId: invoice.organizationId,
    branchId: invoice.branchId,
    action: "ISSUE_CREDIT_NOTE",
    entity: "CreditNote",
    entityId: String(creditNote.id),
    metadata: {
      number,
      invoiceNumber: invoice.number,
      invoiceId: invoice.id,
      orderId: input.orderId,
      refundId: input.refundId,
      netCents: plan.netCents,
      taxCents: plan.taxCents,
      totalCents: plan.totalCents,
      lineCount: plan.lines.length,
      actorRole: input.actor.role,
    },
  })

  return { kind: "issued", creditNoteId: creditNote.id, number, taxCents: plan.taxCents }
}
