import "server-only"

import { and, asc, count, eq, isNotNull, sql } from "drizzle-orm"

import { orders, organizations } from "@/db/schema"
import { NOT_CONFIGURED_OVERDUE_SUMMARY, type OverduePaymentSummary } from "@/lib/payment-control-policy"
import {
  UNPAID_INVOICE_FULFILLMENT_STATUS,
  UNPAID_INVOICE_ORDER_STATUS,
  UNPAID_INVOICE_PAYMENT_STATUS,
} from "@/lib/unpaid-invoice-block"
import type { db } from "@/lib/db"

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/** The most invoices listed back with a status; the count is always exact. */
export const UNPAID_INVOICE_ITEMS_LIMIT = 20

/**
 * Where "does this branch have overdue payments" comes from.
 *
 * This is the one seam the rest of the feature depends on. The resolver, the
 * order gate, the routes and the UI read only the returned shape; none of
 * them knows how it is computed.
 *
 * An organization opts in with `block_ordering_on_unpaid_invoices`, set by
 * Super Admin (plans/OF-PAYMENT-CONTROL-unpaid-invoice-ordering-block.md).
 * With it off the answer is "not configured": nothing is known, nothing is
 * blocked, nothing is shown — the behaviour before the toggle existed. With
 * it on, the branch's unpaid invoices are counted: fulfilled, delivered,
 * invoiced orders still marked UNPAID (`isUnpaidInvoiceOrder` in
 * lib/unpaid-invoice-block.ts). The count is per branch and fenced by both
 * the organization and the branch the gate was given, never by the request.
 *
 * No amount is returned: the status route is readable by Order Portal users,
 * and some tenants hide prices from them.
 */
export type OverduePaymentSource = (
  client: DbClient,
  scope: { organizationId: number; branchId: number },
  now: Date,
) => Promise<OverduePaymentSummary>

export const overduePaymentSource: OverduePaymentSource = async (client, scope) => {
  const [organization] = await client
    .select({ enabled: organizations.blockOrderingOnUnpaidInvoices })
    .from(organizations)
    .where(eq(organizations.id, scope.organizationId))
    .limit(1)
  if (organization?.enabled !== true) return NOT_CONFIGURED_OVERDUE_SUMMARY

  const unpaidInvoiceOfBranch = and(
    eq(orders.organizationId, scope.organizationId),
    eq(orders.branchId, scope.branchId),
    eq(orders.status, UNPAID_INVOICE_ORDER_STATUS),
    eq(orders.fulfillmentStatus, UNPAID_INVOICE_FULFILLMENT_STATUS),
    eq(orders.paymentStatus, UNPAID_INVOICE_PAYMENT_STATUS),
    isNotNull(orders.receiptData),
  )

  const [{ total }] = await client
    .select({ total: count() })
    .from(orders)
    .where(unpaidInvoiceOfBranch)

  const rows = await client
    .select({
      tid: orders.tid,
      invoiceNumber: sql<string | null>`${orders.receiptData}->>'invoiceNumber'`,
      deliveredAt: orders.deliveredAt,
    })
    .from(orders)
    .where(unpaidInvoiceOfBranch)
    .orderBy(asc(orders.deliveredAt), asc(orders.id))
    .limit(UNPAID_INVOICE_ITEMS_LIMIT)

  return {
    configured: true,
    overdueCount: Number(total),
    items: rows.map((row) => ({
      reference: row.invoiceNumber?.trim() || row.tid,
      overdueSince: row.deliveredAt ?? null,
      amountCents: null,
    })),
  }
}
