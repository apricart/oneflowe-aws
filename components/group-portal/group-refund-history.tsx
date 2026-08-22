"use client"

import { useState } from "react"
import useSWR from "swr"
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ListSkeleton } from "@/components/ui/skeleton"
import { fetcher } from "@/lib/fetcher"
import { formatQuantity } from "@/lib/quantity"
import { cn, formatPKR } from "@/lib/utils"

import type { GroupRefundHistoryItem } from "./types"

type HistoryResponse = {
  items: GroupRefundHistoryItem[]
  pagination: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean }
}

/**
 * Refund status colours, deliberately the same vocabulary the order statuses
 * use elsewhere in this portal so a pending refund reads like a pending order.
 */
const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  APPROVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  COMPLETED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  REJECTED: "bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
  SUPERSEDED: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
}

function formatDate(value: string | null): string {
  if (!value) return "—"
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

function statusStyle(status: string): string {
  return STATUS_STYLES[status.toUpperCase()] ?? STATUS_STYLES.SUPERSEDED
}

/**
 * The refund requests this user has raised, grouped under the group order they
 * belong to.
 *
 * A group refund is recorded as one ordinary refund request per branch order —
 * that is what puts it in the administrator's existing queue — so this view
 * exists to put those rows back together into the submission the user actually
 * made, and to show where each one has got to.
 */
export function GroupRefundHistory() {
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<number | null>(null)

  const { data, error, isLoading } = useSWR<HistoryResponse>(
    `/api/v1/group-portal/refunds?page=${page}`,
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
          Your refund requests could not be loaded. Please try again.
        </CardContent>
      </Card>
    )
  }

  const items = data?.items ?? []
  if (items.length === 0) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
          <RotateCcw className="mx-auto mb-3 h-8 w-8 text-slate-300 dark:text-slate-700" />
          You have not requested a refund yet. Open a delivered group order to raise one.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <RefundEnvelopeCard
          key={item.groupOrderId}
          item={item}
          open={expanded === item.groupOrderId}
          onToggle={() => setExpanded(expanded === item.groupOrderId ? null : item.groupOrderId)}
        />
      ))}

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
    </div>
  )
}

function RefundEnvelopeCard({
  item,
  open,
  onToggle,
}: Readonly<{ item: GroupRefundHistoryItem; open: boolean; onToggle: () => void }>) {
  return (
    <Card className="overflow-hidden rounded-2xl">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 p-4 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/50"
      >
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
              {item.reference}
            </span>
            <Badge variant="secondary">{item.groupName}</Badge>
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {item.refunds.length} request{item.refunds.length === 1 ? "" : "s"} ·{" "}
            {formatPKR(item.totalAmountCents / 100)} requested
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Object.entries(item.statusCounts).map(([status, count]) => (
              <span
                key={status}
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                  statusStyle(status),
                )}
              >
                {count} {status.toLowerCase()}
              </span>
            ))}
          </div>
        </div>
        {open
          ? <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
          : <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-400" />}
      </button>

      {open && (
        <div className="space-y-3 border-t border-slate-200 p-4 dark:border-slate-800">
          {item.refunds.map((refund) => (
            <div
              key={refund.refundId}
              className="rounded-xl border border-slate-200 p-3 dark:border-slate-800"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {refund.branchName}
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] text-slate-400">
                    {refund.tid}
                    {refund.refundNumber ? ` · ${refund.refundNumber}` : ""}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                    {formatDate(refund.createdAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {formatPKR(refund.amountCents / 100)}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                      statusStyle(refund.status),
                    )}
                  >
                    {refund.status}
                  </span>
                </div>
              </div>

              {refund.reason && (
                <p className="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                  {refund.reason}
                </p>
              )}

              {refund.items.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {refund.items.map((line) => (
                    <li
                      key={line.orderItemId}
                      className="flex items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-300"
                    >
                      <span className="min-w-0 truncate">{line.productName}</span>
                      <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                        {formatQuantity(line.quantity)} {line.unit || ""} ·{" "}
                        {formatPKR(line.amountCents / 100)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
