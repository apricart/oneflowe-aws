"use client"

import { Check, ChevronDown, ChevronRight, Layers, User, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { cn, formatPKR } from "@/lib/utils"

import { ApprovalOrderTable } from "./approval-order-table"
import {
  type ApprovalGroupOrder,
  STATUS_STYLES,
  formatDateTime,
  isPending,
} from "./approval-types"

type Props = Readonly<{
  item: ApprovalGroupOrder
  expanded: boolean
  onToggleExpanded: () => void
  selectedIds: Set<number>
  onToggleSelection: (orderId: number) => void
  onSelectAllPending: (orderIds: number[], selectAll: boolean) => void
  onDecide: (orderIds: number[], decision: "approve" | "reject") => void
  busy: boolean
}>

/**
 * One group order, identified by its group order reference, with the branch
 * orders beneath it.
 *
 * The whole submission can be decided at once, a subset can be selected, or an
 * individual branch order can be decided on its own row — every route ends at
 * the same per-order authorization on the server.
 */
export function ApprovalGroupCard({
  item,
  expanded,
  onToggleExpanded,
  selectedIds,
  onToggleSelection,
  onSelectAllPending,
  onDecide,
  busy,
}: Props) {
  const pendingOrders = item.orders.filter(isPending)
  const pendingIds = pendingOrders.map((order) => order.id)
  const selectedPendingIds = pendingIds.filter((id) => selectedIds.has(id))
  const allPendingSelected = pendingIds.length > 0 && selectedPendingIds.length === pendingIds.length
  const hasSelection = selectedPendingIds.length > 0

  // A selection scopes the bulk buttons to it; with nothing selected they act
  // on every pending order in this group, which is the common case.
  const targetIds = hasSelection ? selectedPendingIds : pendingIds
  const actionLabel = hasSelection
    ? `${selectedPendingIds.length} selected`
    : `all ${pendingIds.length} pending`

  return (
    <Card className="overflow-hidden rounded-2xl border-slate-200 dark:border-slate-800">
      <CardContent className="p-0">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 dark:border-slate-800 lg:flex-row lg:items-center lg:justify-between">
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-start gap-3 text-left"
          >
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-400">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </span>
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-bold text-slate-900 dark:text-slate-100">
                  {item.reference}
                </span>
                <Badge variant="secondary" className="gap-1 rounded-full text-[10px]">
                  <Layers className="h-3 w-3" />
                  {item.groupName}
                </Badge>
                {item.pendingOrderCount > 0 && (
                  <Badge className={cn("rounded-full text-[10px] font-bold", STATUS_STYLES.PENDING)}>
                    {item.pendingOrderCount} awaiting you
                  </Badge>
                )}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                <span className="flex items-center gap-1">
                  <User className="h-3 w-3" />
                  {item.requestedByName}
                </span>
                <span>{formatDateTime(item.createdAt)}</span>
                <span>
                  {item.scopedOrderCount} branch order{item.scopedOrderCount === 1 ? "" : "s"} in your scope
                </span>
                <span className="font-semibold text-slate-700 dark:text-slate-300">
                  {formatPKR(item.totalCents / 100)}
                </span>
              </span>
            </span>
          </button>

          {pendingIds.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onSelectAllPending(pendingIds, !allPendingSelected)}
                className="h-8 rounded-lg text-xs font-semibold text-slate-500"
              >
                {allPendingSelected ? "Clear selection" : "Select all pending"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || targetIds.length === 0}
                onClick={() => onDecide(targetIds, "reject")}
                className="h-8 gap-1 rounded-lg border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:hover:bg-rose-950/30"
              >
                <X className="h-3.5 w-3.5" />
                Reject {actionLabel}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy || targetIds.length === 0}
                onClick={() => onDecide(targetIds, "approve")}
                className="h-8 gap-1 rounded-lg bg-emerald-600 text-white hover:bg-emerald-500"
              >
                <Check className="h-3.5 w-3.5" />
                Approve {actionLabel}
              </Button>
            </div>
          )}
        </div>

        {expanded && (
          <ApprovalOrderTable
            orders={item.orders}
            selectedIds={selectedIds}
            onToggleSelection={onToggleSelection}
            onDecide={onDecide}
            busy={busy}
          />
        )}

        {item.notes && expanded && (
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <span className="font-semibold">Requester notes:</span> {item.notes}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
