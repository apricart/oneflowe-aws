"use client"

import { useState } from "react"
import useSWR from "swr"
import { AlertTriangle, ChevronDown, ChevronRight, Layers } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ListSkeleton } from "@/components/ui/skeleton"
import { fetcher } from "@/lib/fetcher"
import { cn, formatPKR } from "@/lib/utils"

import type { GroupOrderHistoryItem } from "./types"

type HistoryResponse = {
  items: GroupOrderHistoryItem[]
  pagination: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean }
}

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  APPROVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  FULFILLED: "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300",
  REJECTED: "bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
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
 */
export function GroupOrderHistory() {
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<number | null>(null)

  const { data, error, isLoading } = useSWR<HistoryResponse>(
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
                      </tr>
                    </thead>
                    <tbody>
                      {item.orders.map((order) => (
                        <tr key={order.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                          <td className="py-2 pr-3 text-slate-800 dark:text-slate-200">{order.branchName}</td>
                          <td className="py-2 pr-3 font-mono text-xs text-slate-600 dark:text-slate-300">{order.tid}</td>
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
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

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
    </div>
  )
}
