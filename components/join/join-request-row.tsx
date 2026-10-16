"use client"

import { Clock, MapPin, Users } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  JOINABLE_ROLE_LABELS,
  type JoinRequestStatus,
  type JoinableRole,
} from "@/lib/organization-join"

/**
 * One row of the join queue.
 *
 * The shape is exactly what `GET /api/v1/join-requests` returns, which
 * deliberately excludes the password hash and the submitting address — those
 * exist for the database and for an abuse investigation, not for a screen.
 */
export type JoinRequestRow = {
  id: number
  /** 2 = a department sign-up, reviewed in its own dialog. */
  formVersion?: number
  status: JoinRequestStatus
  requestedRole: JoinableRole
  requestedBranchId: number | null
  requestedBranchName: string | null
  requestedGroupIds: number[]
  requestedBranchIds: number[]
  firstName: string
  lastName: string
  email: string
  username: string
  phone: string | null
  employeeId: string | null
  imprestHolder: string | null
  contactPerson: string | null
  location: string | null
  address: string | null
  decisionReason: string | null
  decidedAt: string | null
  createdUserId: string | null
  createdAt: string
}

const STATUS_STYLES: Record<JoinRequestStatus, string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  rejected: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
}

function formatWhen(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString()
}

function scopeSummary(request: JoinRequestRow): string {
  if (request.requestedBranchName) return request.requestedBranchName
  const groupCount = request.requestedGroupIds?.length ?? 0
  const branchCount = request.requestedBranchIds?.length ?? 0
  const parts: string[] = []
  if (groupCount > 0) parts.push(`${groupCount} group${groupCount === 1 ? "" : "s"}`)
  if (branchCount > 0) parts.push(`${branchCount} branch${branchCount === 1 ? "" : "es"}`)
  return parts.length > 0 ? parts.join(" + ") : "No assignment"
}

export function JoinRequestListRow({
  request,
  onReview,
}: Readonly<{
  request: JoinRequestRow
  /** Absent for a read-only reader: the row then shows no decision control. */
  onReview?: (request: JoinRequestRow) => void
}>) {
  return (
    <li className="flex flex-col gap-3 border-b border-slate-100 p-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold text-slate-900 dark:text-slate-100">
            {request.firstName} {request.lastName}
          </p>
          <Badge className={STATUS_STYLES[request.status]} variant="secondary">
            {request.status}
          </Badge>
        </div>
        <p className="truncate text-sm text-slate-600 dark:text-slate-400">
          <span className="font-mono">{request.username}</span>
          <span aria-hidden="true"> · </span>
          {request.email}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1">
            <Users className="h-3.5 w-3.5" aria-hidden="true" />
            {JOINABLE_ROLE_LABELS[request.requestedRole]}
          </span>
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
            {scopeSummary(request)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            {formatWhen(request.createdAt)}
          </span>
        </div>
        {request.status !== "pending" && request.decisionReason && (
          <p className="text-xs italic text-slate-500 dark:text-slate-400">
            Note: {request.decisionReason}
          </p>
        )}
      </div>

      {request.status === "pending" && onReview && (
        <Button type="button" size="sm" onClick={() => onReview(request)} className="sm:shrink-0">
          Review
        </Button>
      )}
      {request.status === "pending" && !onReview && (
        <p className="text-xs text-slate-400 sm:shrink-0">Awaiting Head Office</p>
      )}
      {request.status !== "pending" && (
        <p className="text-xs text-slate-400 sm:shrink-0">
          {request.decidedAt ? formatWhen(request.decidedAt) : "—"}
        </p>
      )}
    </li>
  )
}
