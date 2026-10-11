import "server-only"

import { and, eq, inArray, sql } from "drizzle-orm"

import {
  auditLogs,
  branches,
  invoiceLines,
  invoices,
  orderItems,
  orders,
  organizations,
  refundItems,
  refunds,
} from "@/db/schema"
import { formatBranchAddress } from "@/lib/branch-address"
import { db } from "@/lib/db"
import { INVOICE_ISSUER } from "@/lib/invoice-issuer"
import {
  karachiDate,
  planIssuedInvoice,
  reservedInvoiceNumber,
  type RefundedLine,
} from "@/lib/invoice-ledger"
import { generateNextInvoiceNumber, lockInvoiceTenantForIssuance } from "@/lib/invoice-number"
import { loadInvoiceParticipants } from "@/lib/server/invoice-participants"

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export const SETTLED_REFUND_STATUSES = ["APPROVED", "COMPLETED"] as const

export type InvoiceIssueOutcome =
  | { kind: "issued"; invoiceId: number; number: string }
  | { kind: "exists"; invoiceId: number }
  | { kind: "skipped"; reason: "NO_ORGANIZATION" | "NOTHING_TO_INVOICE" }

/** The seller as printed, frozen onto each invoice. */
export function sellerSnapshot(): Record<string, unknown> {
  return {
    name: INVOICE_ISSUER.name,
    addressLines: [...INVOICE_ISSUER.addressLines],
    ntn: INVOICE_ISSUER.ntn,
    strn: INVOICE_ISSUER.strn,
  }
}

/**
 * Issue the tax invoice for an order whose delivery has just been recorded
 * (plans/OF-INVOICE-invoice-ledger.md, D2).
 *
 * Runs inside the delivery's own transaction, after the order row has been
 * moved to DELIVERED (which holds its lock): if issuing fails, the delivery is
 * not recorded either, so a delivered order without its invoice cannot exist.
 * Calling it again for the same order does nothing (`invoices_order_uq`).
 *
 * The number is the one the order already holds when it was drawn at creation
 * (the transition reservation), otherwise the next value of the organization's
 * existing series, drawn here so the series stays gap-free. The date is the
 * Karachi date of delivery. Lines are the order lines less what refunds
 * approved before delivery took back.
 */
export async function issueTaxInvoiceAtDelivery(
  tx: Tx,
  input: { orderId: number; actor: { id: string; role: string } },
): Promise<InvoiceIssueOutcome> {
  const [existing] = await tx.select({ id: invoices.id }).from(invoices)
    .where(eq(invoices.orderId, input.orderId)).limit(1)
  if (existing) return { kind: "exists", invoiceId: existing.id }

  const [order] = await tx.select({
    id: orders.id,
    tid: orders.tid,
    organizationId: orders.organizationId,
    branchId: orders.branchId,
    status: orders.status,
    receiptData: orders.receiptData,
    createdByUserId: orders.createdByUserId,
    approvedByUserId: orders.approvedByUserId,
    deliveredAt: orders.deliveredAt,
  }).from(orders).where(eq(orders.id, input.orderId)).limit(1)
  if (!order || order.organizationId === null) return { kind: "skipped", reason: "NO_ORGANIZATION" }
  const organizationId = order.organizationId

  const items = await tx.select({
    orderItemId: orderItems.id,
    productName: orderItems.productName,
    productCode: orderItems.productCode,
    unit: orderItems.unit,
    quantity: orderItems.quantity,
    priceCents: orderItems.priceCents,
    taxRateBp: orderItems.taxRateBp,
    taxCents: orderItems.taxCents,
  }).from(orderItems).where(eq(orderItems.orderId, order.id)).orderBy(orderItems.id)

  const settledRefunds = await tx.select({ id: refunds.id, amountCents: refunds.amountCents })
    .from(refunds)
    .where(and(eq(refunds.orderId, order.id), inArray(refunds.status, [...SETTLED_REFUND_STATUSES])))
  const refundedLines = settledRefunds.length === 0 ? [] : await tx.select({
    orderItemId: refundItems.orderItemId,
    quantity: refundItems.quantity,
    amountCents: refundItems.amountCents,
  }).from(refundItems).where(inArray(refundItems.refundId, settledRefunds.map((refund) => refund.id)))

  const refundedByItem = new Map<number, RefundedLine>()
  for (const line of refundedLines) {
    const current = refundedByItem.get(line.orderItemId) ?? { quantity: 0, grossCents: 0 }
    refundedByItem.set(line.orderItemId, {
      quantity: current.quantity + Number(line.quantity),
      grossCents: current.grossCents + Number(line.amountCents),
    })
  }
  const refundedTotal = settledRefunds.reduce((sum, refund) => sum + Number(refund.amountCents), 0)
  const itemizedTotal = refundedLines.reduce((sum, line) => sum + Number(line.amountCents), 0)

  const plan = planIssuedInvoice({
    items: items.map((item) => ({ ...item, category: null, taxCents: Number(item.taxCents) })),
    refundedByItem,
    unitemizedRefundCents: Math.max(0, refundedTotal - itemizedTotal),
  })
  // Skipped only when refunds took every unit, which leaves the order refunded
  // and undeliverable. Goods delivered free of charge are still a supply, and
  // are invoiced at zero.
  if (plan.lines.length === 0) return { kind: "skipped", reason: "NOTHING_TO_INVOICE" }

  // The number: the reservation drawn at creation, or the next in the series.
  // Both paths hold the organization row FOR SHARE, as issuing always has.
  const reserved = reservedInvoiceNumber(order.receiptData, order.tid)
  let number: string
  if (reserved) {
    await lockInvoiceTenantForIssuance(tx, organizationId)
    number = reserved
  } else {
    number = await generateNextInvoiceNumber(tx, organizationId)
  }

  const [organization] = await tx.select({
    name: organizations.name,
    code: organizations.code,
    ntnNumber: organizations.ntnNumber,
    strnNumber: organizations.strnNumber,
  }).from(organizations).where(eq(organizations.id, organizationId)).limit(1)
  const [branch] = await tx.select({
    name: branches.name,
    costCenterId: branches.costCenterId,
    address: branches.address,
    city: branches.city,
    province: branches.province,
  }).from(branches).where(and(eq(branches.id, order.branchId), eq(branches.organizationId, organizationId))).limit(1)
  const participants = await loadInvoiceParticipants({
    id: order.id,
    createdByUserId: order.createdByUserId,
    approvedByUserId: order.approvedByUserId,
    status: order.status,
  })

  const snapshot = (order.receiptData ?? {}) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null)
  const buyer = {
    organizationName: organization?.name ?? null,
    organizationCode: organization?.code ?? null,
    ntn: text(organization?.ntnNumber),
    strn: text(organization?.strnNumber),
    branchId: order.branchId,
    branchName: branch?.name ?? null,
    costCenterId: text(branch?.costCenterId),
    // Where the goods went, as recorded when the order was placed.
    buyerName: text(snapshot.buyerName) ?? branch?.name ?? null,
    buyerAddress: text(snapshot.buyerAddress) ?? (branch ? formatBranchAddress(branch) : null),
    deliveryAddressLabel: text(snapshot.deliveryAddressLabel),
    poNumber: text(snapshot.poNumber),
    orderTid: order.tid,
  }

  const issuedAt = order.deliveredAt ?? new Date()
  const [invoice] = await tx.insert(invoices).values({
    organizationId,
    branchId: order.branchId,
    orderId: order.id,
    number,
    issueDate: karachiDate(issuedAt),
    issuedAt,
    origin: "ISSUED_AT_SUPPLY",
    status: "ISSUED",
    seller: sellerSnapshot(),
    buyer,
    participants: {
      placedByName: participants.placedByName,
      placedByPhone: participants.placedByPhone,
      approvedByName: participants.approvedByName,
    },
    netCents: plan.netCents,
    taxCents: plan.taxCents,
    discountCents: plan.discountCents,
    deliveryChargesCents: 0,
    totalCents: plan.totalCents,
    issuedByUserId: input.actor.id,
  }).returning({ id: invoices.id })

  await tx.insert(invoiceLines).values(plan.lines.map((line) => ({
    invoiceId: invoice.id,
    organizationId,
    lineNo: line.lineNo,
    orderItemId: line.orderItemId,
    productName: line.productName,
    productCode: line.productCode,
    unit: line.unit,
    category: line.category,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    taxRateBp: line.taxRateBp,
    netCents: line.netCents,
    taxCents: line.taxCents,
    grossCents: line.grossCents,
  })))

  // Every reader that predates the ledger reads the number from the order's
  // snapshot; writing it there keeps them right without touching each one.
  if (!reserved) {
    await tx.update(orders)
      .set({ receiptData: sql`jsonb_set(COALESCE(${orders.receiptData}, '{}'::jsonb), '{invoiceNumber}', to_jsonb(${number}::text))` })
      .where(eq(orders.id, order.id))
  }

  await tx.insert(auditLogs).values({
    userId: input.actor.id,
    organizationId,
    branchId: order.branchId,
    action: "ISSUE_TAX_INVOICE",
    entity: "Invoice",
    entityId: String(invoice.id),
    metadata: {
      orderId: order.id,
      tid: order.tid,
      number,
      reservedAtCreation: Boolean(reserved),
      issueDate: karachiDate(issuedAt),
      netCents: plan.netCents,
      taxCents: plan.taxCents,
      discountCents: plan.discountCents,
      totalCents: plan.totalCents,
      lineCount: plan.lines.length,
      actorRole: input.actor.role,
    },
  })

  return { kind: "issued", invoiceId: invoice.id, number }
}
