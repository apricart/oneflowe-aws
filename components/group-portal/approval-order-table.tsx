"use client"

import { useState } from "react"
import { Check, Copy, Mail, ShieldCheck, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useToast } from "@/hooks/use-toast"
import { cn, formatPKR } from "@/lib/utils"

import { ApprovalOrderSheet } from "./approval-order-sheet"
import {
  type ApprovalOrder,
  STATUS_STYLES,
  formatDateTime,
  isPending,
  normalizeStatus,
} from "./approval-types"

type Props = Readonly<{
  orders: ApprovalOrder[]
  selectedIds: Set<number>
  onToggleSelection: (orderId: number) => void
  onDecide: (orderIds: number[], decision: "approve" | "reject") => void
  busy: boolean
}>

/**
 * The branch orders beneath one group order, each decidable on its own.
 *
 * Only pending rows offer a decision or a selection box; an already-decided
 * order is shown for context and cannot be acted on again. Approved rows expose
 * the fulfilment token and the hand-off to the admin operations mailbox, which
 * is the same step a Branch Admin performs before a Super Admin marks the order
 * delivered.
 *
 * Selecting a row opens the shared order detail drawer, the same panel every
 * other role sees when it opens one of its own orders.
 */
export function ApprovalOrderTable({
  orders,
  selectedIds,
  onToggleSelection,
  onDecide,
  busy,
}: Props) {
  const [viewingOrder, setViewingOrder] = useState<ApprovalOrder | null>(null)

  if (orders.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
        No branch orders in your scope for this group order.
      </p>
    )
  }

  return (
    <>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-collapse text-sm">
        <caption className="sr-only">
          Branch orders in this group order that you can decide
        </caption>
        <thead>
          <tr className="border-b border-slate-200 text-left dark:border-slate-800">
            <th scope="col" className="w-10 px-3 py-2">
              <span className="sr-only">Select</span>
            </th>
            <th scope="col" className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Branch</th>
            <th scope="col" className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Order</th>
            <th scope="col" className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Items</th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Total</th>
            <th scope="col" className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Status</th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Action</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <OrderRow
              key={order.id}
              order={order}
              selected={selectedIds.has(order.id)}
              onToggleSelection={onToggleSelection}
              onDecide={onDecide}
              onView={setViewingOrder}
              busy={busy}
            />
          ))}
        </tbody>
      </table>
    </div>

    <ApprovalOrderSheet
      order={viewingOrder}
      onClose={() => setViewingOrder(null)}
      onDecide={onDecide}
      busy={busy}
    />
    </>
  )
}

function OrderRow({
  order,
  selected,
  onToggleSelection,
  onDecide,
  onView,
  busy,
}: Readonly<{
  order: ApprovalOrder
  selected: boolean
  onToggleSelection: (orderId: number) => void
  onDecide: (orderIds: number[], decision: "approve" | "reject") => void
  onView: (order: ApprovalOrder) => void
  busy: boolean
}>) {
  const status = normalizeStatus(order.status)
  const pending = isPending(order)

  return (
    <>
      <tr
        onClick={() => onView(order)}
        className="cursor-pointer border-b border-slate-100 align-middle transition-colors last:border-0 hover:bg-slate-50 dark:border-slate-800/70 dark:hover:bg-slate-800/40"
      >
        {/* The controls inside the row act on the order directly, so they must
            not also open the drawer behind them. */}
        <td className="px-3 py-3" onClick={(event) => event.stopPropagation()}>
          {pending ? (
            <Checkbox
              checked={selected}
              onCheckedChange={() => onToggleSelection(order.id)}
              disabled={busy}
              aria-label={`Select order ${order.tid} for ${order.branchName}`}
            />
          ) : null}
        </td>
        <td className="px-3 py-3">
          <span className="font-medium text-slate-900 dark:text-slate-100">{order.branchName}</span>
          {order.branchCostCenterId && (
            <span className="ml-2 text-xs text-slate-400">{order.branchCostCenterId}</span>
          )}
        </td>
        <td className="px-3 py-3">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onView(order)
            }}
            className="rounded font-mono text-xs text-indigo-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-400"
          >
            {order.tid}
          </button>
          <span className="block text-[11px] text-slate-400">{formatDateTime(order.createdAt)}</span>
        </td>
        <td className="px-3 py-3 text-slate-600 dark:text-slate-300">{order.itemCount}</td>
        <td className="px-3 py-3 text-right font-semibold text-slate-900 dark:text-slate-100">
          {formatPKR(order.totalCents / 100)}
        </td>
        <td className="px-3 py-3">
          <Badge
            variant="secondary"
            className={cn("rounded-full text-[10px] font-bold", STATUS_STYLES[status] ?? STATUS_STYLES.REFUNDED)}
          >
            {status}
          </Badge>
        </td>
        <td className="px-3 py-3" onClick={(event) => event.stopPropagation()}>
          {pending ? (
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onDecide([order.id], "reject")}
                className="h-8 gap-1 rounded-lg border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:hover:bg-rose-950/30"
              >
                <X className="h-3.5 w-3.5" />
                Reject
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => onDecide([order.id], "approve")}
                className="h-8 gap-1 rounded-lg bg-emerald-600 text-white hover:bg-emerald-500"
              >
                <Check className="h-3.5 w-3.5" />
                Approve
              </Button>
            </div>
          ) : (
            <p className="text-right text-xs text-slate-400">
              {status === "APPROVED" ? formatDateTime(order.approvedAt) : "—"}
            </p>
          )}
        </td>
      </tr>

      {order.rejectionReason && (
        <tr className="border-b border-slate-100 dark:border-slate-800/70">
          <td />
          <td colSpan={6} className="px-3 pb-3 text-xs text-rose-600 dark:text-rose-400">
            Reason: {order.rejectionReason}
          </td>
        </tr>
      )}

      {status === "APPROVED" && order.approvalToken && (
        <tr className="border-b border-slate-100 dark:border-slate-800/70">
          <td />
          <td colSpan={6} className="px-3 pb-3">
            <TokenHandoff orderId={order.id} tid={order.tid} token={order.approvalToken} />
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * The fulfilment token and its hand-off to admin operations.
 *
 * The token is the credential a Super Admin needs to mark the order delivered,
 * so it is only ever displayed for an order this approver has access to and
 * that is already approved.
 */
function TokenHandoff({
  orderId,
  tid,
  token,
}: Readonly<{ orderId: number; tid: string; token: string }>) {
  const { toast } = useToast()
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(token)
      toast({ title: "Token copied", description: `Fulfilment token for ${tid}` })
    } catch {
      toast({
        title: "Could not copy",
        description: "Copy the token manually from the field.",
        variant: "destructive",
      })
    }
  }

  const sendToken = async () => {
    setSending(true)
    try {
      const res = await fetch(`/api/v1/orders/${orderId}/send-token-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      const payload = await res.json().catch(() => ({}))

      if (!res.ok) {
        toast({
          title: "Token email not sent",
          description: payload?.error || "Please try again.",
          variant: "destructive",
        })
        return
      }

      setSent(true)
      toast({
        title: "Token sent to admin",
        description: `${tid} — the admin can now mark this order delivered.`,
      })
    } catch {
      toast({
        title: "Token email not sent",
        description: "Check your connection and try again.",
        variant: "destructive",
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900/60 dark:bg-emerald-950/20 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-2">
        <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
            Fulfilment token
          </p>
          <p className="truncate font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
            {token}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1 rounded-lg" onClick={copyToken}>
          <Copy className="h-3.5 w-3.5" />
          Copy
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1 rounded-lg"
          onClick={sendToken}
          disabled={sending}
        >
          <Mail className="h-3.5 w-3.5" />
          {(() => {
            if (sending) return "Sending…"
            return sent ? "Sent to admin" : "Email to admin"
          })()}
        </Button>
      </div>
    </div>
  )
}
