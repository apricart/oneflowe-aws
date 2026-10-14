"use client"

import { useViewerAccess } from "@/lib/hooks/use-viewer-access"
import { useState } from "react"

import useSWR from "swr"
import { AlertCircle, DoorOpen, RefreshCw } from "lucide-react"

import { useAppContext } from "@/components/context/app-context"
import { JoinCodeCard } from "@/components/join/join-code-card"
import { JoinDecisionDialog } from "@/components/join/join-decision-dialog"
import { JoinRequestListRow, type JoinRequestRow } from "@/components/join/join-request-row"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ListSkeleton } from "@/components/ui/skeleton"
import { fetcher } from "@/lib/fetcher"
import { JOIN_REQUEST_STATUSES, type JoinRequestStatus } from "@/lib/organization-join"
import { cn } from "@/lib/utils"

/**
 * Head Office: the join code, and who is asking to join.
 *
 * The queue is the organization's own — the endpoint takes its tenant from the
 * session and has no `organizationId` parameter, so there is nothing on this
 * page that could point it at another tenant.
 */

type JoinRequestsResponse = {
  items: JoinRequestRow[]
  pendingCount: number
}

const FILTERS: ReadonlyArray<{ value: JoinRequestStatus | "all"; label: string }> = [
  { value: "pending", label: "Waiting" },
  ...JOIN_REQUEST_STATUSES
    .filter((status) => status !== "pending")
    .map((status) => ({ value: status, label: status === "approved" ? "Approved" : "Rejected" })),
  { value: "all", label: "All" },
]

export default function JoinRequestsPage() {
  // The read-only Viewer reads the queue and decides nothing.
  const { readOnly } = useViewerAccess()
  const { organizationId } = useAppContext()
  const [filter, setFilter] = useState<JoinRequestStatus | "all">("pending")
  const [reviewing, setReviewing] = useState<JoinRequestRow | null>(null)

  const query = filter === "all" ? "" : `?status=${filter}`
  const { data, error, isLoading, mutate } = useSWR<JoinRequestsResponse>(
    `/api/v1/join-requests${query}`,
    fetcher,
  )

  const items = Array.isArray(data?.items) ? data.items : []

  return (
    <main className="min-h-[calc(100vh-4rem)] space-y-6 bg-slate-50/50 p-4 md:p-8 dark:bg-slate-950">
      <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)] sm:flex-row sm:items-center md:p-5 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-blue-50/50 bg-gradient-to-tr from-blue-100 to-indigo-100 shadow-inner dark:border-blue-800/50 dark:from-blue-900/50 dark:to-indigo-900/50">
            <DoorOpen className="h-6 w-6 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Join Requests</h1>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Your organization&apos;s join code, and everyone asking to be let in
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {typeof data?.pendingCount === "number" && data.pendingCount > 0 && (
            <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
              {data.pendingCount} waiting
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-2"
            onClick={() => mutate()}
          >
            <RefreshCw className="h-4 w-4" />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      <JoinCodeCard />

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
              <span className="sr-only">Loading join requests…</span>
              <ListSkeleton rows={4} />
            </div>
          )}

          {error && !isLoading && (
            <div role="alert" className="flex items-start gap-3 p-6">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden="true" />
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-100">
                  Join requests could not be loaded
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
              {filter === "pending"
                ? "Nobody is waiting to join."
                : "No requests with this status."}
            </p>
          )}

          {!isLoading && !error && items.length > 0 && (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {items.map((request) => (
                <JoinRequestListRow
                  key={request.id}
                  request={request}
                  onReview={readOnly ? undefined : setReviewing}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {!readOnly && (
        <JoinDecisionDialog
          request={reviewing}
          organizationId={organizationId ? Number.parseInt(organizationId, 10) : null}
          onClose={() => setReviewing(null)}
          onDecided={() => mutate()}
        />
      )}
    </main>
  )
}
