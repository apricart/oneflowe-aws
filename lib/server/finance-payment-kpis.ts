import "server-only"

import { and, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm"

import { orders, organizations } from "@/db/schema"
import { db } from "@/lib/db"
import {
  summarizePaymentKpis,
  type AgingRow,
  type OrganizationPaymentRow,
  type PaymentAgingBucketKey,
  type PaymentKpis,
} from "@/lib/finance-payment-kpis"

/**
 * The two bounded aggregates behind the payment KPIs: one row per
 * organization, and one per aging bucket of the unpaid orders. Both are keyed
 * on the same conditions, so the buckets add up to the unpaid total.
 * See plans/OF-FINANCE-finance-role.md.
 */

/** `max(0, total − refunded)` — what is still to be collected on an order. */
const netCents = sql`GREATEST(${orders.totalCents} - COALESCE(${orders.refundAmountCents}, 0), 0)`
const isPaid = sql`UPPER(${orders.paymentStatus}) = 'PAID'`
const isDelivered = sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) = 'DELIVERED'`

/** Whole days since approval (creation for an order approved before the column existed). */
const ageDays = sql`FLOOR(EXTRACT(EPOCH FROM (NOW() - COALESCE(${orders.approvedAt}, ${orders.createdAt}))) / 86400)`

/** The SQL twin of `paymentAgingBucketFor`. */
const agingBucket = sql<PaymentAgingBucketKey>`CASE
  WHEN ${ageDays} <= 30 THEN '0-30'
  WHEN ${ageDays} <= 60 THEN '31-60'
  WHEN ${ageDays} <= 90 THEN '61-90'
  ELSE '90+'
END`

const count = (condition: SQL) => sql<number>`COUNT(*) FILTER (WHERE ${condition})`.mapWith(Number)
const amount = (condition: SQL) => sql<number>`COALESCE(SUM(${netCents}) FILTER (WHERE ${condition}), 0)`.mapWith(Number)

export type PaymentKpiQuery = {
  /** The organizations to read: Finance's fenced set, or Super Admin's selection. Null is every organization. */
  organizationIds: number[] | null
  startDate: Date | null
  endDate: Date | null
}

export async function loadPaymentKpis(query: PaymentKpiQuery): Promise<PaymentKpis> {
  if (query.organizationIds && query.organizationIds.length === 0) {
    return summarizePaymentKpis({ organizations: [], aging: [] })
  }

  const conditions = and(
    sql`UPPER(TRIM(${orders.status})) IN ('APPROVED', 'FULFILLED')`,
    query.organizationIds ? inArray(orders.organizationId, query.organizationIds) : undefined,
    query.startDate ? gte(orders.createdAt, query.startDate) : undefined,
    query.endDate ? lte(orders.createdAt, query.endDate) : undefined,
  )
  const unpaid = sql`NOT (${isPaid})`

  const [organizationRows, agingRows] = await Promise.all([
    db
      .select({
        organizationId: orders.organizationId,
        organizationName: organizations.name,
        paidCount: count(isPaid),
        paidCents: amount(isPaid),
        unpaidCount: count(unpaid),
        unpaidCents: amount(unpaid),
        unpaidDeliveredCount: count(sql`${unpaid} AND ${isDelivered}`),
        unpaidDeliveredCents: amount(sql`${unpaid} AND ${isDelivered}`),
      })
      .from(orders)
      .innerJoin(organizations, eq(orders.organizationId, organizations.id))
      .where(conditions)
      .groupBy(orders.organizationId, organizations.name)
      .limit(1000),
    db
      .select({
        bucket: agingBucket,
        count: sql<number>`COUNT(*)`.mapWith(Number),
        amountCents: sql<number>`COALESCE(SUM(${netCents}), 0)`.mapWith(Number),
      })
      .from(orders)
      .where(and(conditions, unpaid))
      .groupBy(agingBucket),
  ])

  const organizationsOut: OrganizationPaymentRow[] = organizationRows.map((row) => ({
    organizationId: Number(row.organizationId),
    organizationName: row.organizationName,
    paid: { count: row.paidCount, amountCents: row.paidCents },
    unpaid: { count: row.unpaidCount, amountCents: row.unpaidCents },
    unpaidDelivered: { count: row.unpaidDeliveredCount, amountCents: row.unpaidDeliveredCents },
  }))
  const agingOut: AgingRow[] = agingRows.map((row) => ({
    bucket: row.bucket,
    count: row.count,
    amountCents: row.amountCents,
  }))

  return summarizePaymentKpis({ organizations: organizationsOut, aging: agingOut })
}
