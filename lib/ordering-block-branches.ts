import { z } from "zod"

import { isExceptionActive, type PaymentControlException } from "@/lib/payment-control-policy"
import { hasReachedUnpaidInvoiceLimit, isLastOrderBeforeBlock } from "@/lib/unpaid-invoice-alerts"

/**
 * Head Office's Ordering Blocks page: every active branch of its own
 * organization, where each stands against the unpaid-invoice block, and the
 * Head Office exception that lets a blocked branch keep ordering
 * (plans/OF-PAYMENT-CONTROL-head-office-ordering-blocks-page.md).
 *
 * Pure. The standing is decided by the rules the order gate and the alerts
 * already use — `hasReachedUnpaidInvoiceLimit`, `isLastOrderBeforeBlock` and
 * `isExceptionActive` — so the page cannot call a branch blocked while an
 * order would go through, or the reverse. The page is presentation; the gate
 * is the control.
 */

/**
 * BLOCKED          the limit is reached and no exception is in force.
 * EXCEPTION_ACTIVE the limit is reached and Head Office's exception lets it order.
 * LAST_ORDER       one unpaid invoice short of the limit.
 * UNPAID           some unpaid invoices, further from the limit.
 * CLEAR            no unpaid invoice.
 *
 * An exception in force below the limit (granted in advance, or the dues
 * cleared since) does not change the standing; the row still shows it.
 */
export type OrderingBlockStanding = "BLOCKED" | "EXCEPTION_ACTIVE" | "LAST_ORDER" | "UNPAID" | "CLEAR"

export function orderingBlockStandingOf(input: {
  unpaidInvoiceCount: number
  threshold: number
  exceptionActive: boolean
}): OrderingBlockStanding {
  if (hasReachedUnpaidInvoiceLimit(input.unpaidInvoiceCount, input.threshold)) {
    return input.exceptionActive ? "EXCEPTION_ACTIVE" : "BLOCKED"
  }
  if (isLastOrderBeforeBlock(input.unpaidInvoiceCount, input.threshold)) return "LAST_ORDER"
  return input.unpaidInvoiceCount > 0 ? "UNPAID" : "CLEAR"
}

export const ORDERING_BLOCK_FILTERS = ["attention", "blocked", "exception", "all"] as const
export type OrderingBlockFilter = (typeof ORDERING_BLOCK_FILTERS)[number]

/** Where the page opens: the branches someone has to act on or keep an eye on. */
export const DEFAULT_ORDERING_BLOCK_FILTER: OrderingBlockFilter = "attention"
export const ORDERING_BLOCKS_DEFAULT_PAGE_SIZE = 25
export const ORDERING_BLOCKS_MAX_PAGE_SIZE = 100

export const orderingBlockBranchesQuerySchema = z.object({
  filter: z.enum(ORDERING_BLOCK_FILTERS).default(DEFAULT_ORDERING_BLOCK_FILTER),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(ORDERING_BLOCKS_MAX_PAGE_SIZE).default(ORDERING_BLOCKS_DEFAULT_PAGE_SIZE),
}).strict()

export type OrderingBlockBranchesQuery = z.infer<typeof orderingBlockBranchesQuerySchema>

/** The latest exception on a branch, as the page shows it. Dates are ISO strings. */
export type OrderingBlockExceptionView = {
  id: number
  startAt: string
  expiresAt: string
  revokedAt: string | null
  active: boolean
  grantedByName: string | null
  reason: string | null
}

export type OrderingBlockBranchView = {
  branchId: number
  branchName: string
  branchCode: string | null
  unpaidInvoiceCount: number
  standing: OrderingBlockStanding
  orderingAllowed: boolean
  exception: OrderingBlockExceptionView | null
}

export type OrderingBlockSummary = {
  branches: number
  blocked: number
  exceptionActive: number
  lastOrder: number
}

/**
 * The wire shape of `GET /api/v1/payment-control/branches`. `enabled: false`
 * means the organization does not block ordering on unpaid invoices: the page
 * says so and lists nothing.
 */
export type OrderingBlockBranchesView =
  | { enabled: false }
  | {
    enabled: true
    threshold: number
    summary: OrderingBlockSummary
    items: OrderingBlockBranchView[]
    total: number
    page: number
    pageSize: number
  }

export const ORDERING_BLOCKS_DISABLED: OrderingBlockBranchesView = Object.freeze({ enabled: false })

export type OrderingBlockBranchFacts = {
  branchId: number
  branchName: string
  branchCode: string | null
  unpaidInvoiceCount: number
  exception: (Pick<PaymentControlException, "id" | "startAt" | "expiresAt" | "revokedAt" | "reason"> & { grantedByName: string | null }) | null
}

function presentException(exception: NonNullable<OrderingBlockBranchFacts["exception"]>, now: Date): OrderingBlockExceptionView {
  return {
    id: exception.id,
    startAt: exception.startAt.toISOString(),
    expiresAt: exception.expiresAt.toISOString(),
    revokedAt: exception.revokedAt ? exception.revokedAt.toISOString() : null,
    active: isExceptionActive(exception, now),
    grantedByName: exception.grantedByName,
    reason: exception.reason,
  }
}

export function orderingBlockBranchOf(facts: OrderingBlockBranchFacts, threshold: number, now: Date): OrderingBlockBranchView {
  const exceptionActive = isExceptionActive(facts.exception, now)
  const standing = orderingBlockStandingOf({ unpaidInvoiceCount: facts.unpaidInvoiceCount, threshold, exceptionActive })
  return {
    branchId: facts.branchId,
    branchName: facts.branchName,
    branchCode: facts.branchCode,
    unpaidInvoiceCount: facts.unpaidInvoiceCount,
    standing,
    orderingAllowed: standing !== "BLOCKED",
    exception: facts.exception ? presentException(facts.exception, now) : null,
  }
}

function matchesFilter(row: OrderingBlockBranchView, filter: OrderingBlockFilter): boolean {
  switch (filter) {
    case "blocked":
      return row.standing === "BLOCKED"
    case "exception":
      return row.exception?.active === true
    case "attention":
      return row.standing === "BLOCKED" || row.standing === "LAST_ORDER" || row.exception?.active === true
    case "all":
      return true
  }
}

function matchesSearch(row: OrderingBlockBranchView, search: string | undefined): boolean {
  if (!search) return true
  const needle = search.toLocaleLowerCase()
  return row.branchName.toLocaleLowerCase().includes(needle)
    || (row.branchCode ?? "").toLocaleLowerCase().includes(needle)
}

const STANDING_ORDER: Record<OrderingBlockStanding, number> = {
  BLOCKED: 0,
  EXCEPTION_ACTIVE: 1,
  LAST_ORDER: 2,
  UNPAID: 3,
  CLEAR: 4,
}

/** Blocked first, then the ones ordering on an exception, then by unpaid count, then by name. */
function byUrgency(left: OrderingBlockBranchView, right: OrderingBlockBranchView): number {
  return STANDING_ORDER[left.standing] - STANDING_ORDER[right.standing]
    || right.unpaidInvoiceCount - left.unpaidInvoiceCount
    || left.branchName.localeCompare(right.branchName)
    || left.branchId - right.branchId
}

/**
 * The page for one query. The summary counts every branch of the
 * organization, whatever the filter or search, so the headline figures do
 * not move as Head Office narrows the list.
 */
export function orderingBlockBranchesPage(
  facts: readonly OrderingBlockBranchFacts[],
  input: { threshold: number; now: Date; query: OrderingBlockBranchesQuery },
): OrderingBlockBranchesView {
  const rows = facts.map((row) => orderingBlockBranchOf(row, input.threshold, input.now))
  const summary: OrderingBlockSummary = {
    branches: rows.length,
    blocked: rows.filter((row) => row.standing === "BLOCKED").length,
    exceptionActive: rows.filter((row) => row.exception?.active === true).length,
    lastOrder: rows.filter((row) => row.standing === "LAST_ORDER").length,
  }
  const matching = rows
    .filter((row) => matchesFilter(row, input.query.filter) && matchesSearch(row, input.query.search))
    .sort(byUrgency)
  const start = (input.query.page - 1) * input.query.pageSize
  return {
    enabled: true,
    threshold: input.threshold,
    summary,
    items: matching.slice(start, start + input.query.pageSize),
    total: matching.length,
    page: input.query.page,
    pageSize: input.query.pageSize,
  }
}
