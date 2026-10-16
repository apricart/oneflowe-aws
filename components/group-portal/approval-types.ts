import { isAwaitingApproval, isAwaitingCorrection } from "@/lib/order-correction"

/**
 * Client-side shapes for the Group User approval queue.
 *
 * These mirror the server types in `lib/server/group-order-approvals`, with
 * dates as the ISO strings that survive JSON transport.
 */

export type ApprovalOrder = {
  id: number
  tid: string
  branchId: number
  branchName: string
  branchCostCenterId: string | null
  status: string
  /** Set once refunded; decides whether a refunded row still offers its invoice. */
  statusAtRefund: string | null
  fulfillmentStatus: string
  totalCents: number
  /**
   * Units ordered across the whole order. Both approval views report the same
   * figure, so the column means one thing wherever it appears.
   */
  itemCount: number
  createdAt: string | null
  approvedAt: string | null
  rejectionReason: string | null
  returnedForCorrectionAt?: string | null
  correctionRequestNote?: string | null
  approvalToken: string | null
  /** The approval level it waits at; null where the organization has no levels. */
  approvalLevel?: number | null
  /** This approver does not hold the order's level, so it is someone else's to decide. */
  levelDecisionLocked?: boolean
}

export type ApprovalGroupOrder = {
  id: number
  reference: string
  createdAt: string | null
  notes: string | null
  groupId: number | null
  groupName: string
  requestedByName: string
  scopedOrderCount: number
  pendingOrderCount: number
  totalCents: number
  statusCounts: Record<string, number>
  orders: ApprovalOrder[]
}

export type ApprovalQueueSummary = {
  pendingOrders: number
  approvedOrders: number
  rejectedOrders: number
  pendingGroupOrders: number
  branchesInScope: number
}

export type ApprovalQueueResponse = {
  items: ApprovalGroupOrder[]
  pagination: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean }
  summary: ApprovalQueueSummary
}

export type DecisionResult = {
  orderId: number
  ok: boolean
  status: "approved" | "rejected" | "failed"
  message?: string
  approvalToken?: string
}

export type DecisionResponse = {
  message: string
  decision: "approve" | "reject"
  succeeded: number
  failed: number
  results: DecisionResult[]
}

export type ApprovalFilter = "pending" | "all"

export const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  APPROVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  FULFILLED: "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300",
  REJECTED: "bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
  REFUNDED: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
}

export function normalizeStatus(status: string | null | undefined): string {
  return String(status || "PENDING").toUpperCase()
}

export function isPending(order: ApprovalOrder): boolean {
  return normalizeStatus(order.status) === "PENDING"
}

/**
 * Pending and with the approver — the only orders an approval can act on.
 * A returned order is still pending (it may be rejected) but waits on its
 * requester, so it is kept out of approvals and bulk selection.
 */
export function isAwaitingApprovalDecision(order: ApprovalOrder): boolean {
  return isAwaitingApproval(order) && !order.levelDecisionLocked
}

/**
 * Pending and this approver's to decide: an order waiting at an approval
 * level this approver does not hold is someone else's (the server refuses it
 * anyway). See plans/OF-APPROVAL-LEVELS-route-orders-by-level.md.
 */
export function isDecidableByApprover(order: ApprovalOrder): boolean {
  return isPending(order) && !order.levelDecisionLocked
}

export function isReturnedForCorrection(order: ApprovalOrder): boolean {
  return isAwaitingCorrection(order)
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—"
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}
