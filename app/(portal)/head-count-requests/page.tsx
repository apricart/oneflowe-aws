"use client"

import { useState } from "react"

import useSWR from "swr"
import { AlertCircle, Plus, RefreshCw, UsersRound } from "lucide-react"

import { HeadCountDecisionDialog } from "@/components/branch-head-count/head-count-decision-dialog"
import {
  HeadCountRequestDialog,
  type HeadCountRequestableBranch,
} from "@/components/branch-head-count/head-count-request-dialog"
import {
  HeadCountRequestRow,
  type HeadCountRequestListItem,
} from "@/components/branch-head-count/head-count-request-row"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ListSkeleton } from "@/components/ui/skeleton"
import { formatBranchHeadCount, type HeadCountRequestStatus } from "@/lib/branch-head-count"
import { fetcher } from "@/lib/fetcher"
import { cn } from "@/lib/utils"

/**
 * Branch head count requests (plans/OF-BRANCH-head-count.md): one page, as
 * `/delivery-addresses` is. A Branch Admin or Group User sees its branches'
 * requests and asks for a change; Head Office sees the tenant's queue and
 * decides. `canDecide` comes from the server, so this page never infers
 * authority from a role of its own — and the PATCH re-checks regardless.
 */

type HeadCountRequestsResponse = {
  items: HeadCountRequestListItem[]
  pendingCount: number
  requestableBranches: HeadCountRequestableBranch[]
  canDecide: boolean
}

const FILTERS: ReadonlyArray<{ value: HeadCountRequestStatus | "all"; label: string }> = [
  { value: "pending", label: "Waiting" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
]

export default function HeadCountRequestsPage() {
  const [filter, setFilter] = useState<HeadCountRequestStatus | "all">("all")
  const [reviewing, setReviewing] = useState<HeadCountRequestListItem | null>(null)
  const [requesting, setRequesting] = useState(false)

  const query = filter === "all" ? "" : `?status=${filter}`
  const { data, error, isLoading, mutate } = useSWR<HeadCountRequestsResponse>(
    `/api/v1/branch-head-count-requests${query}`,
    fetcher,
  )

  const items = Array.isArray(data?.items) ? data.items : []
  const requestableBranches = Array.isArray(data?.requestableBranches) ? data.requestableBranches : []
  const canDecide = data?.canDecide === true

  return (
    <main className="min-h-[calc(100vh-4rem)] space-y-6 bg-slate-50/50 p-4 md:p-8 dark:bg-slate-950">
      <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)] sm:flex-row sm:items-center md:p-5 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-blue-50/50 bg-gradient-to-tr from-blue-100 to-indigo-100 shadow-inner dark:border-blue-800/50 dark:from-blue-900/50 dark:to-indigo-900/50">
            <UsersRound className="h-6 w-6 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
              {canDecide ? "Head Count Requests" : "Branch Head Count"}
            </h1>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {canDecide
                ? "Head count changes your branches have asked for"
                : "How many people work at your branch, as Head Office has approved it"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {typeof data?.pendingCount === "number" && data.pendingCount > 0 && (
            <Badge
              variant="secondary"
              className="bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
            >
              {data.pendingCount} waiting
            </Badge>
          )}
          <Button variant="outline" size="sm" className="h-9 gap-2" onClick={() => mutate()}>
            <RefreshCw className="h-4 w-4" />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
          {requestableBranches.length > 0 && (
            <Button size="sm" className="h-9 gap-2" onClick={() => setRequesting(true)}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Request a change</span>
              <span className="sm:hidden">Request</span>
            </Button>
          )}
        </div>
      </div>

      {requestableBranches.length > 0 && (
        <Card className="rounded-2xl border-slate-200 shadow-sm dark:border-slate-800">
          <CardContent className="p-0">
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {requestableBranches.map((branch) => (
                <li key={branch.id} className="flex items-center justify-between p-4 text-sm">
                  <span className="font-medium text-slate-900 dark:text-slate-100">{branch.name}</span>
                  <span className="text-slate-600 dark:text-slate-300">
                    Head count: <span className="font-semibold">{formatBranchHeadCount(branch.headCount)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filter === option.value}
            onClick={() => setFilter(option.value)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm font-medium transition",
              filter === option.value
                ? "border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200"
                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <Card className="rounded-2xl border-slate-200 shadow-sm dark:border-slate-800">
        <CardContent className="p-0">
          {isLoading && (
            <div className="p-6" role="status" aria-live="polite">
              <span className="sr-only">Loading head count requests…</span>
              <ListSkeleton rows={4} />
            </div>
          )}

          {error && !isLoading && (
            <div role="alert" className="flex items-start gap-3 p-6">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden="true" />
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-100">
                  Head count requests could not be loaded
                </p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Nothing has been approved or rejected. Try again.
                </p>
                <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={() => mutate()}>
                  <RefreshCw className="h-4 w-4" />
                  Try again
                </Button>
              </div>
            </div>
          )}

          {!isLoading && !error && items.length === 0 && (
            <p className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
              {filter === "pending" ? "Nothing is waiting for a decision." : "No head count requests yet."}
            </p>
          )}

          {!isLoading && !error && items.length > 0 && (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {items.map((request) => (
                <HeadCountRequestRow
                  key={request.id}
                  request={request}
                  canDecide={canDecide}
                  onReview={setReviewing}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <HeadCountRequestDialog
        open={requesting}
        branches={requestableBranches}
        onOpenChange={setRequesting}
        onRequested={() => mutate()}
      />

      <HeadCountDecisionDialog
        request={reviewing}
        onClose={() => setReviewing(null)}
        onDecided={() => mutate()}
      />
    </main>
  )
}
