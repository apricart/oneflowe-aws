/**
 * Copying the invoices issued before the ledger existed into it
 * (plans/OF-INVOICE-invoice-ledger.md, D6). Pure: the script supplies rows and
 * performs the write; every rule that decides a row is here.
 *
 * Nothing already given to a customer changes. Each row keeps the number and
 * the printed date its invoice carried, its figures are the order's own, and it
 * keeps printing from the order's snapshot (`legacy_snapshot` is an archive of
 * it). Refunds approved before the ledger are recorded as credited totals; no
 * credit note is created for them, because a numbered document dated today for
 * a refund made months ago would be worse than none.
 */
import { isOrderSupplied, deriveInvoiceStatus } from "@/lib/invoice-status"
import { karachiDate, legacyPrintedDate, refundTaxCents } from "@/lib/invoice-ledger"

/** One refund approved before the ledger, as recorded. */
export type LegacyApprovedRefund = {
  amountCents: number
  /** What the refund recorded as its tax part; 0 for every refund the app made before the ledger. */
  taxRefundCents: number
  /** Its itemised lines: refunded gross and the order line's tax rate. */
  lines: Array<{ grossCents: number; taxRateBp: number | null }>
}

export type LegacyInvoiceSource = {
  orderId: number
  tid: string
  organizationId: number | null
  branchId: number
  status: string | null
  fulfillmentStatus: string | null
  statusAtRefund: string | null
  refundAmountCents: number | null
  subtotalCents: number
  taxCents: number
  totalCents: number
  receiptData: Record<string, unknown> | null
  createdAt: Date
  deliveredAt: Date | null
  fulfilledAt: Date | null
  organizationName: string | null
  organizationCode: string | null
  organizationNtn: string | null
  organizationStrn: string | null
  branchName: string | null
  branchCostCenterId: string | null
  /** The order's approved (or completed) refunds. */
  approvedRefunds: LegacyApprovedRefund[]
}

/**
 * The tax inside the refunds already given on an order.
 *
 * A refund that recorded its tax part keeps it (the K-Electric imports did).
 * Every refund the app made before the ledger recorded 0, so its tax is worked
 * out the way a refund's tax is worked out now (`refundTaxCents`): each refunded
 * line split at its own rate, the rest in the order's own tax-to-total
 * proportion. Without this, a refunded invoice would carry its whole credit as
 * net and none as tax.
 */
export function legacyCreditedTaxCents(source: Pick<LegacyInvoiceSource, "approvedRefunds" | "taxCents" | "totalCents">): number {
  return source.approvedRefunds.reduce((sum, refund) => {
    const amount = Math.max(0, Math.round(Number(refund.amountCents) || 0))
    const recorded = Math.max(0, Math.round(Number(refund.taxRefundCents) || 0))
    if (recorded > 0) return sum + Math.min(recorded, amount)
    return sum + refundTaxCents({
      refundAmountCents: amount,
      lines: refund.lines,
      order: { taxCents: source.taxCents, totalCents: source.totalCents },
    })
  }, 0)
}

export type LegacyInvoiceRow = {
  orderId: number
  organizationId: number
  branchId: number
  number: string
  issueDate: string
  issuedAt: string
  origin: "LEGACY_SNAPSHOT" | "LEGACY_IMPORT"
  status: "ISSUED" | "PARTIALLY_CREDITED" | "CREDITED"
  buyer: Record<string, unknown>
  netCents: number
  taxCents: number
  totalCents: number
  creditedNetCents: number
  creditedTaxCents: number
  creditedTotalCents: number
}

export type LegacySkipReason = "NOT_SUPPLIED" | "NO_ORGANIZATION" | "NO_INVOICE_NUMBER"

export type LegacyInvoicePlan =
  | { kind: "insert"; row: LegacyInvoiceRow }
  | { kind: "skip"; orderId: number; reason: LegacySkipReason }

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null

const nonNegative = (value: unknown): number => {
  const parsed = Math.round(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function planLegacyInvoice(source: LegacyInvoiceSource): LegacyInvoicePlan {
  if (!isOrderSupplied(source)) return { kind: "skip", orderId: source.orderId, reason: "NOT_SUPPLIED" }
  if (source.organizationId === null) return { kind: "skip", orderId: source.orderId, reason: "NO_ORGANIZATION" }
  const snapshot = source.receiptData ?? {}
  const number = text(snapshot.invoiceNumber)
  if (!number || number.length > 40) return { kind: "skip", orderId: source.orderId, reason: "NO_INVOICE_NUMBER" }

  const derived = deriveInvoiceStatus(source)
  const status = derived === "CREDITED" || derived === "PARTIALLY_CREDITED" ? derived : "ISSUED"

  const netCents = nonNegative(source.subtotalCents)
  const taxCents = nonNegative(source.taxCents)
  const totalCents = nonNegative(source.totalCents)
  const creditedTotalCents = Math.min(nonNegative(source.refundAmountCents), totalCents)
  const creditedTaxCents = Math.min(legacyCreditedTaxCents(source), creditedTotalCents, taxCents)
  const creditedNetCents = creditedTotalCents - creditedTaxCents

  const suppliedAt = source.deliveredAt ?? source.fulfilledAt ?? source.createdAt
  return {
    kind: "insert",
    row: {
      orderId: source.orderId,
      organizationId: source.organizationId,
      branchId: source.branchId,
      number,
      // The date the invoice was printed with, as the customer holds it.
      issueDate: legacyPrintedDate(snapshot.date) ?? karachiDate(suppliedAt),
      issuedAt: suppliedAt.toISOString(),
      origin: number.startsWith("KE-LEGACY-") ? "LEGACY_IMPORT" : "LEGACY_SNAPSHOT",
      status,
      buyer: {
        organizationName: text(snapshot.organizationName) ?? source.organizationName,
        organizationCode: source.organizationCode,
        ntn: text(source.organizationNtn) ?? text(snapshot.organizationNtn),
        strn: text(source.organizationStrn),
        branchId: source.branchId,
        branchName: source.branchName,
        costCenterId: text(source.branchCostCenterId),
        buyerName: text(snapshot.buyerName) ?? source.branchName,
        buyerAddress: text(snapshot.buyerAddress),
        deliveryAddressLabel: text(snapshot.deliveryAddressLabel),
        poNumber: text(snapshot.poNumber),
        orderTid: source.tid,
        recordedAtBackfill: true,
      },
      netCents,
      taxCents,
      totalCents,
      creditedNetCents,
      creditedTaxCents,
      creditedTotalCents,
    },
  }
}

export type LegacyBackfillSummary = {
  toInsert: number
  byOrganization: Record<string, number>
  skipped: Record<LegacySkipReason, number>
  creditedTotalCents: number
  totalCents: number
}

export function summarizeLegacyBackfill(plans: LegacyInvoicePlan[]): LegacyBackfillSummary {
  const summary: LegacyBackfillSummary = {
    toInsert: 0,
    byOrganization: {},
    skipped: { NOT_SUPPLIED: 0, NO_ORGANIZATION: 0, NO_INVOICE_NUMBER: 0 },
    creditedTotalCents: 0,
    totalCents: 0,
  }
  for (const plan of plans) {
    if (plan.kind === "skip") {
      summary.skipped[plan.reason] += 1
      continue
    }
    summary.toInsert += 1
    const key = String(plan.row.organizationId)
    summary.byOrganization[key] = (summary.byOrganization[key] ?? 0) + 1
    summary.totalCents += plan.row.totalCents
    summary.creditedTotalCents += plan.row.creditedTotalCents
  }
  return summary
}

/** What the plan digest covers: exactly the rows that would be written. */
export function backfillDigestInput(plans: LegacyInvoicePlan[]): unknown[] {
  return plans
    .filter((plan): plan is Extract<LegacyInvoicePlan, { kind: "insert" }> => plan.kind === "insert")
    .map(({ row }) => [row.orderId, row.organizationId, row.number, row.issueDate, row.totalCents, row.creditedTotalCents, row.creditedTaxCents, row.status])
}
