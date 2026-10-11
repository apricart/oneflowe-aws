/**
 * Blocking new orders on unpaid invoices
 * (plans/OF-PAYMENT-CONTROL-unpaid-invoice-ordering-block.md).
 *
 * Pure. What counts as an unpaid invoice, and how a refusal is recognised and
 * worded on the client. The count itself is taken in
 * lib/server/overdue-payment-source.ts, whose SQL mirrors
 * `isUnpaidInvoiceOrder`; the decision is the payment-control policy's.
 */
import {
  PAYMENT_CONTROL_BLOCKED_CODE,
  blockedMessageOf,
  type PaymentControlReason,
} from "@/lib/payment-control-policy"

/**
 * The canonical column values an unpaid invoice carries. An invoice counts
 * only once the order is fulfilled and delivered — exactly the orders the
 * Super Admin Paid/Unpaid control can act on (`isPaymentStatusUpdateEligible`
 * in lib/business-rules.ts) — so every block can be cleared by marking
 * invoices paid.
 */
export const UNPAID_INVOICE_ORDER_STATUS = "FULFILLED"
export const UNPAID_INVOICE_FULFILLMENT_STATUS = "DELIVERED"
export const UNPAID_INVOICE_PAYMENT_STATUS = "UNPAID"

export const UNPAID_INVOICES_DIALOG_TITLE = "Unpaid invoices"

/** `audit_logs.action` for a Super Admin switching the toggle on or off. */
export const UNPAID_INVOICE_ORDERING_BLOCK_AUDIT_ACTION = "UPDATE_UNPAID_INVOICE_ORDERING_BLOCK"

type InvoiceOrderLike = {
  status?: string | null
  fulfillmentStatus?: string | null
  paymentStatus?: string | null
  receiptData?: unknown
  totalCents?: number | string | null
  refundAmountCents?: number | string | null
}

const canonical = (value: unknown) => String(value ?? "").trim().toUpperCase()

/**
 * Whether an order still has money to pay: its total less what was refunded.
 * Goods delivered free of charge are invoiced at zero
 * (plans/OF-INVOICE-invoice-ledger.md, "Fixes after the edge-case review"),
 * and an invoice for nothing is not an unpaid invoice. Mirrored in SQL by
 * `orderStillOwesSql` (lib/server/overdue-payment-source.ts). An order read
 * without its total is not judged on it.
 */
export function orderStillOwes(order: Pick<InvoiceOrderLike, "totalCents" | "refundAmountCents">): boolean {
  if (order.totalCents === undefined) return true
  return Number(order.totalCents || 0) - Number(order.refundAmountCents || 0) > 0
}

export function isUnpaidInvoiceOrder(order: InvoiceOrderLike): boolean {
  return Boolean(order.receiptData)
    && canonical(order.status) === UNPAID_INVOICE_ORDER_STATUS
    && canonical(order.fulfillmentStatus) === UNPAID_INVOICE_FULFILLMENT_STATUS
    && canonical(order.paymentStatus) === UNPAID_INVOICE_PAYMENT_STATUS
    && orderStillOwes(order)
}

/** What the popup needs to explain a refusal. */
export type OrderingBlock = {
  unpaidInvoiceCount: number
  threshold: number
  message: string
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const PAYMENT_CONTROL_REASONS = new Set<PaymentControlReason>([
  "NOT_CONFIGURED",
  "NO_OVERDUE_PAYMENTS",
  "BELOW_THRESHOLD",
  "THRESHOLD_REACHED",
  "EXCEPTION_ACTIVE",
  "EXCEPTION_EXPIRED",
  "EXCEPTION_REVOKED",
])

function reasonOf(value: unknown): PaymentControlReason {
  return PAYMENT_CONTROL_REASONS.has(value as PaymentControlReason)
    ? (value as PaymentControlReason)
    : "THRESHOLD_REACHED"
}

/**
 * The refusal from `POST /api/v1/orders`: a 409 carrying the payment-control
 * code. Anything else — another 409, a malformed body — is not a block and is
 * left to the caller's ordinary error handling.
 */
export function parseOrderingBlockedResponse(httpStatus: number, body: unknown): OrderingBlock | null {
  if (httpStatus !== 409 || !body || typeof body !== "object") return null
  const candidate = body as { code?: unknown; error?: unknown; paymentControl?: unknown }
  if (candidate.code !== PAYMENT_CONTROL_BLOCKED_CODE) return null
  const details = candidate.paymentControl as { overdueCount?: unknown; threshold?: unknown; reason?: unknown } | null
  if (!details || !isCount(details.overdueCount) || !isCount(details.threshold)) return null
  const message = typeof candidate.error === "string" && candidate.error.trim()
    ? candidate.error
    : blockedMessageOf({ reason: reasonOf(details.reason), overdueCount: details.overdueCount, threshold: details.threshold })
  return { unpaidInvoiceCount: details.overdueCount, threshold: details.threshold, message }
}

/**
 * The same block read ahead of submission from `GET /api/v1/payment-control`,
 * so the popup can appear before an order is attempted. Null means "nothing to
 * show" — including a malformed view, since the server refuses the order
 * anyway if the branch is blocked.
 */
export function orderingBlockFromStatusView(view: unknown): OrderingBlock | null {
  if (!view || typeof view !== "object") return null
  const candidate = view as { orderingAllowed?: unknown; overdueCount?: unknown; threshold?: unknown; reason?: unknown }
  if (candidate.orderingAllowed !== false) return null
  if (!isCount(candidate.overdueCount) || !isCount(candidate.threshold)) return null
  return {
    unpaidInvoiceCount: candidate.overdueCount,
    threshold: candidate.threshold,
    message: blockedMessageOf({
      reason: reasonOf(candidate.reason),
      overdueCount: candidate.overdueCount,
      threshold: candidate.threshold,
    }),
  }
}

export type BlockedBranch = {
  branchId: number
  branchName: string
  unpaidInvoiceCount: number
}

type GroupBranchResultLike = {
  status?: unknown
  branchId?: unknown
  branchName?: unknown
  code?: unknown
  unpaidInvoiceCount?: unknown
}

/** What the popup shows: one sentence, and the locations when there are several. */
export type UnpaidInvoicesNotice = {
  message: string
  branches: BlockedBranch[]
}

export function noticeForBlock(block: OrderingBlock): UnpaidInvoicesNotice {
  return { message: block.message, branches: [] }
}

export function noticeForBlockedBranches(branches: readonly BlockedBranch[]): UnpaidInvoicesNotice | null {
  if (branches.length === 0) return null
  return {
    message: "No order was placed for the locations below because they have unpaid invoices. Please pay your dues before ordering for them again.",
    branches: [...branches],
  }
}

export function unpaidInvoiceCountLabel(count: number): string {
  return `${count} unpaid invoice${count === 1 ? "" : "s"}`
}

/**
 * The branches a group submission skipped because of unpaid invoices. A
 * group order commits per branch, so the others may have gone through.
 */
export function blockedBranchesOf(results: readonly GroupBranchResultLike[] | null | undefined): BlockedBranch[] {
  if (!Array.isArray(results)) return []
  return results.flatMap((result) => {
    if (result?.status !== "failed" || result.code !== PAYMENT_CONTROL_BLOCKED_CODE) return []
    if (typeof result.branchId !== "number" || typeof result.branchName !== "string") return []
    if (!isCount(result.unpaidInvoiceCount)) return []
    return [{ branchId: result.branchId, branchName: result.branchName, unpaidInvoiceCount: result.unpaidInvoiceCount }]
  })
}
