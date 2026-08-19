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
  fulfillmentStatus: string
  totalCents: number
  itemCount: number
  createdAt: string | null
  approvedAt: string | null
  rejectionReason: string | null
  approvalToken: string | null
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

export function formatDateTime(value: string | null): string {
  if (!value) return "—"
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}
