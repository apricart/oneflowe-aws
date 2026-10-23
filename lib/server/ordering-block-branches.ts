import "server-only"

import { and, asc, count, desc, eq } from "drizzle-orm"

import { branches, orders, paymentControlExceptions, users } from "@/db/schema"
import type { db } from "@/lib/db"
import {
  ORDERING_BLOCKS_DISABLED,
  orderingBlockBranchesPage,
  type OrderingBlockBranchFacts,
  type OrderingBlockBranchesQuery,
  type OrderingBlockBranchesView,
} from "@/lib/ordering-block-branches"

import { loadUnpaidInvoiceBlockConfig, unpaidInvoiceOrdersOf } from "./overdue-payment-source"

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Every active branch of one organization against its unpaid-invoice block,
 * for Head Office's Ordering Blocks page
 * (plans/OF-PAYMENT-CONTROL-head-office-ordering-blocks-page.md).
 *
 * `organizationId` is the caller's own, from the users row, never a request
 * value. Every input is read the gate's way: the toggle and the limit through
 * `loadUnpaidInvoiceBlockConfig`, the count through `unpaidInvoiceOrdersOf`,
 * and each branch's latest exception in the order `loadLatestException` takes
 * it (newest start, then newest id). With the toggle off nothing is read
 * beyond the organization row and nothing is listed.
 *
 * Two queries whatever the organization's size — one grouped count, one
 * latest exception per branch — and the response is one bounded page.
 */
export async function loadOrderingBlockBranches(
  client: DbClient,
  input: { organizationId: number; query: OrderingBlockBranchesQuery; now: Date },
): Promise<OrderingBlockBranchesView> {
  const config = await loadUnpaidInvoiceBlockConfig(client, input.organizationId)
  if (!config) return ORDERING_BLOCKS_DISABLED

  const counted = await client
    .select({
      branchId: branches.id,
      branchName: branches.name,
      branchCode: branches.code,
      unpaidInvoiceCount: count(orders.id),
    })
    .from(branches)
    .leftJoin(orders, and(eq(orders.branchId, branches.id), unpaidInvoiceOrdersOf(input.organizationId)))
    .where(and(eq(branches.organizationId, input.organizationId), eq(branches.status, "active")))
    .groupBy(branches.id, branches.name, branches.code)
    .orderBy(asc(branches.id))

  const latestExceptions = await client
    .selectDistinctOn([paymentControlExceptions.branchId], {
      branchId: paymentControlExceptions.branchId,
      id: paymentControlExceptions.id,
      startAt: paymentControlExceptions.startAt,
      expiresAt: paymentControlExceptions.expiresAt,
      revokedAt: paymentControlExceptions.revokedAt,
      reason: paymentControlExceptions.reason,
      grantedByName: users.fullName,
    })
    .from(paymentControlExceptions)
    .leftJoin(users, eq(users.id, paymentControlExceptions.grantedByUserId))
    .where(eq(paymentControlExceptions.organizationId, input.organizationId))
    .orderBy(
      asc(paymentControlExceptions.branchId),
      desc(paymentControlExceptions.startAt),
      desc(paymentControlExceptions.id),
    )

  const exceptionByBranch = new Map(latestExceptions.map((row) => [row.branchId, row]))
  const facts: OrderingBlockBranchFacts[] = counted.map((row) => {
    const exception = exceptionByBranch.get(row.branchId)
    return {
      branchId: row.branchId,
      branchName: row.branchName,
      branchCode: row.branchCode ?? null,
      unpaidInvoiceCount: Number(row.unpaidInvoiceCount),
      exception: exception
        ? {
          id: exception.id,
          startAt: exception.startAt,
          expiresAt: exception.expiresAt,
          revokedAt: exception.revokedAt,
          reason: exception.reason,
          grantedByName: exception.grantedByName ?? null,
        }
        : null,
    }
  })

  return orderingBlockBranchesPage(facts, { threshold: config.threshold, now: input.now, query: input.query })
}
