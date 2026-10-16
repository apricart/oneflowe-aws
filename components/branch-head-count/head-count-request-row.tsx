"use client"

import { ArrowRight, Clock, MapPin } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatBranchHeadCount, type HeadCountRequestStatus } from "@/lib/branch-head-count"

/**
 * One head count request, as the queue and the branch's own list show it. The
 * shape is what `GET /api/v1/branch-head-count-requests` returns.
 */
export type HeadCountRequestListItem = {
  id: number
  branchId: number
  branchName: string | null
  branchHeadCount: number | null
  requestedHeadCount: number
  currentHeadCount: number | null
  status: HeadCountRequestStatus
  requestReason: string | null
  requestedByName: string | null
  appliedPreviousHeadCount: number | null
  decisionReason: string | null
  decidedAt: string | null
  createdAt: string
}

const STATUS_STYLES: Record<HeadCountRequestStatus, string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  rejected: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
}

const STATUS_LABELS: Record<HeadCountRequestStatus, string> = {
  pending: "Awaiting Head Office",
  approved: "Approved",
  rejected: "Rejected",
}

export function formatRequestWhen(value: string | null): string {
  if (!value) return "—"
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString()
}

export function HeadCountRequestRow({
  request,
  canDecide,
  onReview,
}: Readonly<{
  request: HeadCountRequestListItem
  canDecide: boolean
  onReview: (request: HeadCountRequestListItem) => void
}>) {
  // What it was when asked; an approved one shows what it actually replaced.
  const from = request.status === "approved" ? request.appliedPreviousHeadCount : request.currentHeadCount

  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold text-slate-900 dark:text-slate-100">
            {request.branchName ?? `Branch ${request.branchId}`}
          </p>
          <Badge className={STATUS_STYLES[request.status]} variant="secondary">
            {STATUS_LABELS[request.status]}
          </Badge>
        </div>
        <p className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <span>{formatBranchHeadCount(from)}</span>
          <ArrowRight className="h-3.5 w-3.5 text-slate-400" aria-label="to" />
          <span className="font-semibold">{formatBranchHeadCount(request.requestedHeadCount)}</span>
          <span className="text-xs text-slate-500 dark:text-slate-400">people</span>
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
            Now {formatBranchHeadCount(request.branchHeadCount)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            {formatRequestWhen(request.createdAt)}
          </span>
          {request.requestedByName && <span>Requested by {request.requestedByName}</span>}
        </div>
        {request.requestReason && (
          <p className="text-xs italic text-slate-500 dark:text-slate-400">
            Reason: {request.requestReason}
          </p>
        )}
        {request.status !== "pending" && request.decisionReason && (
          <p className="text-xs italic text-slate-500 dark:text-slate-400">
            Note: {request.decisionReason}
          </p>
        )}
      </div>

      {canDecide && request.status === "pending" ? (
        <Button type="button" size="sm" onClick={() => onReview(request)} className="sm:shrink-0">
          Review
        </Button>
      ) : (
        <p className="text-xs text-slate-400 sm:shrink-0">
          {request.status === "pending" ? "Waiting" : formatRequestWhen(request.decidedAt)}
        </p>
      )}
    </li>
  )
}
