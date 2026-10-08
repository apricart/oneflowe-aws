"use client"

import { useState } from "react"
import useSWR from "swr"
import { AlertTriangle, Ban, ChevronDown, ChevronRight, Layers, Mail, Pencil, RotateCcw, Send } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ReceiptIconButton } from "@/components/receipts/receipt-icon-button"
import { ListSkeleton } from "@/components/ui/skeleton"
import { useToast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import { cn, formatPKR } from "@/lib/utils"

import { BranchOrderDetailSheet, type BranchOrder } from "@/components/group-portal/branch-order-detail-sheet"
import { BranchOrderEditSheet } from "@/components/group-portal/branch-order-edit-sheet"
import { CancelGroupOrderDialog, type GroupCancelTarget } from "@/components/group-portal/cancel-group-order-dialog"
import { isCancellableGroupOrderStatus } from "@/lib/group-order-cancel"
import { ResubmitOrderDialog } from "@/components/orders/order-correction"
import { isAwaitingCorrection } from "@/lib/order-correction"

import { GroupRefundDialog } from "./group-refund-dialog"
import { TokenHandoff } from "./token-handoff"
import type { GroupOrderHistoryItem } from "./types"

/**
 * A branch order is worth offering a refund on once it has been delivered —
 * the same point at which the single-branch Order Portal opens its own refund
 * form. The server decides what is actually refundable; this only governs
 * whether the button is worth showing.
 */
function hasDeliveredOrder(item: GroupOrderHistoryItem): boolean {
  return item.orders.some(
    (order) => order.status.toUpperCase() === "FULFILLED"
      && order.fulfillmentStatus.toUpperCase() === "DELIVERED",
  )
}

/** Branch orders still waiting for approval — the only ones a requester may cancel. */
function pendingOrderCount(item: GroupOrderHistoryItem): number {
  return item.orders.filter((order) => isCancellableGroupOrderStatus(order.status)).length
}

type HistoryResponse = {
  items: GroupOrderHistoryItem[]
  pagination: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean }
}

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  APPROVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  FULFILLED: "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300",
  REJECTED: "bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
  CANCELLED: "bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
  REFUNDED: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
}

function formatDate(value: string | null): string {
  if (!value) return "—"
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

/**
 * The user's own group orders, newest first, each expandable to the branch
 * orders it produced. This is how a group reference is traced back to the
 * individual orders the rest of the application works with.
 *
 * A branch order opens in the same side sheet "Other orders" uses
 * (`BranchOrderDetailSheet`), so an order reads and acts the same in both tabs.
 */
export function GroupOrderHistory() {
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [refundTarget, setRefundTarget] = useState<{ id: number; reference: string } | null>(null)
  // A branch order an approver returned for correction is corrected here — the
  // same branch-scoped edit and resubmission the server re-checks.
  const [editTarget, setEditTarget] = useState<CorrectableOrder | null>(null)
  const [resubmitTarget, setResubmitTarget] = useState<CorrectableOrder | null>(null)
  const [openOrder, setOpenOrder] = useState<BranchOrder | null>(null)
  const [cancelTarget, setCancelTarget] = useState<GroupCancelTarget | null>(null)

  const { data, error, isLoading, mutate } = useSWR<HistoryResponse>(
    `/api/v1/group-portal/orders?page=${page}`,
    fetcher,
    { revalidateOnFocus: true },
  )

  if (isLoading && !data) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="p-6"><ListSkeleton rows={4} /></CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card role="alert" className="rounded-2xl border-rose-200 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/20">
        <CardContent className="p-5 text-sm text-slate-700 dark:text-slate-300">
          Your group orders could not be loaded. Please try again.
        </CardContent>
      </Card>
    )
  }

  const items = data?.items ?? []
  if (items.length === 0) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
          <Layers className="mx-auto mb-3 h-8 w-8 text-slate-300 dark:text-slate-700" />
          You have not submitted a group order yet.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const isOpen = expanded === item.id
        const pendingCount = pendingOrderCount(item)
        const refundable = hasDeliveredOrder(item)
        return (
          <Card key={item.id} className="overflow-hidden rounded-2xl">
            <button
              type="button"
              onClick={() => setExpanded(isOpen ? null : item.id)}
              aria-expanded={isOpen}
              className="flex w-full items-start justify-between gap-3 p-4 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/50"
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {item.reference}
                  </span>
                  <Badge variant="secondary">{item.groupName}</Badge>
                  {item.failures.length > 0 && (
                    <Badge variant="destructive" className="gap-1">
                      <AlertTriangle className="h-3 w-3" />
                      {item.failures.length} skipped
                    </Badge>
                  )}
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {formatDate(item.createdAt)} · {item.createdOrderCount} order
                  {item.createdOrderCount === 1 ? "" : "s"} · {formatPKR(item.totalCents / 100)}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(item.statusCounts).map(([status, count]) => (
                    <span
                      key={status}
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                        STATUS_STYLES[status] ?? STATUS_STYLES.REFUNDED,
                      )}
                    >
                      {count} {status.toLowerCase()}
                    </span>
                  ))}
                </div>
              </div>
              {isOpen
                ? <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
                : <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-400" />}
            </button>

            {(refundable || pendingCount > 0) && (
              <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-4 py-2 dark:border-slate-800/70">
                {/* Only what is still waiting for approval can be withdrawn;
                    the server cancels just those and keeps the rest. */}
                {pendingCount > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 rounded-lg border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/40"
                    onClick={() => setCancelTarget({
                      kind: "submission",
                      groupOrderId: item.id,
                      reference: item.reference,
                      pendingCount,
                    })}
                  >
                    <Ban className="h-3.5 w-3.5" />
                    Cancel pending orders ({pendingCount})
                  </Button>
                )}
                {refundable && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 rounded-lg"
                    onClick={() => setRefundTarget({ id: item.id, reference: item.reference })}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Request refund
                  </Button>
                )}
              </div>
            )}

            {isOpen && (
              <div className="border-t border-slate-200 p-4 dark:border-slate-800">
                {item.notes && (
                  <p className="mb-3 whitespace-pre-line rounded-lg bg-slate-50 p-2.5 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                    {item.notes}
                  </p>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                        <th scope="col" className="pb-2 font-medium">Branch</th>
                        <th scope="col" className="pb-2 font-medium">Order</th>
                        <th scope="col" className="pb-2 text-right font-medium">Items</th>
                        <th scope="col" className="pb-2 text-right font-medium">Total</th>
                        <th scope="col" className="pb-2 text-right font-medium">Status</th>
                        <th scope="col" className="pb-2 text-right font-medium">Invoice</th>
                      </tr>
                    </thead>
                    <tbody>
                      {item.orders.map((order) => (
                        <tr
                          key={order.id}
                          onClick={() => setOpenOrder({ ...order })}
                          className="cursor-pointer border-b border-slate-100 transition last:border-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40"
                        >
                          <td className="py-2 pr-3 text-slate-800 dark:text-slate-200">{order.branchName}</td>
                          <td className="py-2 pr-3">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                setOpenOrder({ ...order })
                              }}
                              aria-label={`Open order ${order.tid}`}
                              className="rounded font-mono text-xs text-indigo-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300"
                            >
                              {order.tid}
                            </button>
                          </td>
                          <td className="py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{order.itemCount}</td>
                          <td className="py-2 text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">
                            {formatPKR(order.totalCents / 100)}
                          </td>
                          <td className="py-2 text-right">
                            <span
                              className={cn(
                                "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                                STATUS_STYLES[order.status.toUpperCase()] ?? STATUS_STYLES.REFUNDED,
                              )}
                            >
                              {order.status}
                            </span>
                            {order.rejectionReason && (
                              <span className="mt-1 block text-[10px] text-rose-600 dark:text-rose-400">
                                {order.rejectionReason}
                              </span>
                            )}
                            {order.status.toUpperCase() === "CANCELLED" && order.cancellationReason && (
                              <span className="mt-1 block text-[10px] text-rose-600 dark:text-rose-400">
                                Cancelled: {order.cancellationReason}
                              </span>
                            )}
                            {isAwaitingCorrection(order) && (
                              <span className="mt-1 block space-y-1 text-left">
                                <span className="block text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                                  Returned for correction
                                </span>
                                <span className="block whitespace-pre-line text-[11px] text-amber-800 dark:text-amber-200">
                                  {order.correctionRequestNote}
                                </span>
                                <span className="flex justify-end gap-1.5">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="h-7 gap-1 rounded-lg px-2 text-[11px]"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      setEditTarget(order)
                                    }}
                                  >
                                    <Pencil className="h-3 w-3" />
                                    Edit
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    className="h-7 gap-1 rounded-lg px-2 text-[11px]"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      setResubmitTarget(order)
                                    }}
                                  >
                                    <Send className="h-3 w-3" />
                                    Resubmit
                                  </Button>
                                </span>
                              </span>
                            )}
                          </td>
                          {/* Renders only once the order is approved; the
                              invoice endpoints re-check the same rule. */}
                          <td className="py-2 text-right" onClick={(event) => event.stopPropagation()}>
                            <ReceiptIconButton
                              orderId={order.id}
                              orderStatus={order.status}
                              statusAtRefund={order.statusAtRefund}
                              variant="outline"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* An approved order carries the credential the administrator
                    needs to mark it delivered. The server only returns a token
                    for an approved order this user raised, so a row without one
                    simply shows nothing here. */}
                {(() => {
                  const tokenOrders = item.orders.filter((order) => order.approvalToken)
                  if (tokenOrders.length === 0) return null
                  return (
                    <div className="mt-3 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                          Fulfilment tokens — the admin needs these to mark the orders delivered
                        </p>
                        {tokenOrders.length > 1 && (
                          <SendAllTokensButton
                            groupOrderId={item.id}
                            count={tokenOrders.length}
                            onFulfilled={() => { void mutate() }}
                          />
                        )}
                      </div>
                      {tokenOrders.map((order) => (
                        <TokenHandoff
                          key={order.id}
                          orderId={order.id}
                          tid={order.tid}
                          token={order.approvalToken as string}
                          branchName={order.branchName}
                          onFulfilled={() => { void mutate() }}
                        />
                      ))}
                    </div>
                  )
                })()}

                {item.failures.length > 0 && (
                  <div className="mt-3 rounded-xl border border-rose-100 bg-rose-50/50 p-3 dark:border-rose-900/50 dark:bg-rose-950/20">
                    <p className="text-xs font-medium text-rose-700 dark:text-rose-400">
                      Branches skipped in this submission
                    </p>
                    <ul className="mt-1.5 space-y-1">
                      {item.failures.map((failure) => (
                        <li key={failure.branchId} className="text-xs text-slate-600 dark:text-slate-300">
                          <span className="font-medium">{failure.branchName}:</span> {failure.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </Card>
        )
      })}

      {data && data.pagination.totalPages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
            Previous
          </Button>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Page {data.pagination.page} of {data.pagination.totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!data.pagination.hasMore}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      )}

      <GroupRefundDialog
        groupOrderId={refundTarget?.id ?? null}
        reference={refundTarget?.reference ?? ""}
        open={refundTarget !== null}
        onClose={() => setRefundTarget(null)}
        onSubmitted={() => { void mutate() }}
      />

      <BranchOrderDetailSheet
        order={openOrder}
        onClose={() => setOpenOrder(null)}
        onEdit={(target) => { setOpenOrder(null); setEditTarget(target) }}
        onResubmit={(target) => { setOpenOrder(null); setResubmitTarget(target) }}
        onChanged={() => { void mutate() }}
        onCancel={(target) => {
          setOpenOrder(null)
          setCancelTarget({ kind: "order", orderId: target.id, tid: target.tid })
        }}
      />

      <CancelGroupOrderDialog
        target={cancelTarget}
        onClose={() => setCancelTarget(null)}
        onCancelled={() => { void mutate() }}
      />

      <BranchOrderEditSheet
        order={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => { void mutate() }}
      />
      <ResubmitOrderDialog
        order={resubmitTarget}
        onClose={() => setResubmitTarget(null)}
        onResubmitted={() => { void mutate() }}
      />
    </div>
  )
}

type CorrectableOrder = {
  id: number
  tid: string
  branchId: number
  branchName?: string | null
  correctionRequestNote?: string | null
}

/**
 * Hand every token in one group order to admin operations in a single message.
 *
 * The per-branch buttons above stay: sometimes one branch needs re-sending on
 * its own. This exists because a group order routinely approves into a dozen or
 * more branch orders, and sending those one at a time would both bury the
 * administrator and exhaust the shared email rate limit part-way through.
 */
function SendAllTokensButton({
  groupOrderId,
  count,
  onFulfilled,
}: Readonly<{
  groupOrderId: number
  count: number
  /** Called once the hand-off has settled at least one order, so history can refresh. */
  onFulfilled?: () => void
}>) {
  const { toast } = useToast()
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const sendAll = async () => {
    setSending(true)
    try {
      const res = await fetch(`/api/v1/group-portal/orders/${groupOrderId}/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      const payload = await res.json().catch(() => ({}))

      if (!res.ok) {
        toast({
          title: "Tokens not sent",
          description: payload?.error || "Please try again.",
          variant: "destructive",
        })
        return
      }

      setSent(true)
      toast({
        title: payload?.fulfilledCount ? "Tokens sent — orders fulfilled" : "Tokens sent to admin",
        description: payload?.message || `${count} tokens shared in one email.`,
      })
      // Only a hand-off that actually settled an order changes what history
      // shows; one waiting on delivery leaves those orders approved.
      if (payload?.fulfilledCount) onFulfilled?.()
    } catch {
      toast({
        title: "Tokens not sent",
        description: "Check your connection and try again.",
        variant: "destructive",
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-7 gap-1.5 rounded-lg text-xs"
      onClick={sendAll}
      disabled={sending}
    >
      <Mail className="h-3.5 w-3.5" />
      {(() => {
        if (sending) return "Sending…"
        return sent ? "All tokens sent" : `Email all ${count} to admin`
      })()}
    </Button>
  )
}
