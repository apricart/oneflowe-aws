import "server-only"

import { and, asc, count, eq, inArray } from "drizzle-orm"

import { branches, orders } from "@/db/schema"
import type { db } from "@/lib/db"
import { isExceptionActive } from "@/lib/payment-control-policy"
import {
  NO_UNPAID_INVOICE_ALERTS,
  hasReachedUnpaidInvoiceLimit,
  unpaidInvoiceAlertsOf,
  type UnpaidInvoiceAlertsView,
} from "@/lib/unpaid-invoice-alerts"

import { loadUnpaidInvoiceBlockConfig, unpaidInvoiceOrdersOf } from "./overdue-payment-source"
import { loadLatestException } from "./payment-control"

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Which of the caller's branches are blocked by unpaid invoices, and which
 * are one unpaid invoice short of it
 * (plans/OF-PAYMENT-CONTROL-unpaid-invoice-alerts.md).
 *
 * `organizationId` and `branchIds` are the caller's own — the users row's
 * branch or the resolved assignment set — never a request value; the
 * branches are fenced to the organization again here. Every input to the
 * gate's decision is read the gate's way: the toggle and limit through
 * `loadUnpaidInvoiceBlockConfig`, the count through `unpaidInvoiceOrdersOf`,
 * and, for a branch at its limit, the latest exception through
 * `loadLatestException` judged by `isExceptionActive`. Inactive branches
 * cannot order and are left out. No amount and no invoice reference is
 * returned.
 */
export async function loadUnpaidInvoiceAlerts(
  client: DbClient,
  scope: { organizationId: number; branchIds: readonly number[] },
  now: Date,
): Promise<UnpaidInvoiceAlertsView> {
  if (scope.branchIds.length === 0) return NO_UNPAID_INVOICE_ALERTS

  const config = await loadUnpaidInvoiceBlockConfig(client, scope.organizationId)
  if (!config) return NO_UNPAID_INVOICE_ALERTS

  const rows = await client
    .select({ branchId: branches.id, branchName: branches.name, unpaidInvoiceCount: count(orders.id) })
    .from(branches)
    .leftJoin(orders, and(eq(orders.branchId, branches.id), unpaidInvoiceOrdersOf(scope.organizationId)))
    .where(and(
      inArray(branches.id, [...scope.branchIds]),
      eq(branches.organizationId, scope.organizationId),
      eq(branches.status, "active"),
    ))
    .groupBy(branches.id, branches.name)
    .orderBy(asc(branches.id))

  const judged = await Promise.all(rows.map(async (row) => {
    const unpaidInvoiceCount = Number(row.unpaidInvoiceCount)
    const exceptionActive = hasReachedUnpaidInvoiceLimit(unpaidInvoiceCount, config.threshold)
      ? isExceptionActive(await loadLatestException(client, row.branchId), now)
      : false
    return { branchId: row.branchId, branchName: row.branchName, unpaidInvoiceCount, exceptionActive }
  }))

  return unpaidInvoiceAlertsOf(judged, config.threshold)
}
