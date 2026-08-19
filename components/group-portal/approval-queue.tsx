"use client"

import { useCallback, useMemo, useState } from "react"
import useSWR from "swr"
import {
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Inbox,
  RefreshCw,
  XCircle,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ListSkeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import { cn } from "@/lib/utils"

import { ApprovalGroupCard } from "./approval-group-card"
import {
  type ApprovalFilter,
  type ApprovalQueueResponse,
  type DecisionResponse,
} from "./approval-types"

type PendingDecision = {
  orderIds: number[]
  decision: "approve" | "reject"
}

const REJECTION_REASON_MAX = 2_000

/**
 * The Group User's approval workspace.
 *
 * Orders arrive grouped under the group order reference they were raised with,
 * so a submission that fanned out across many branches is decided as the unit
 * it was created as — while every individual branch order remains decidable on
 * its own. Approvals and rejections are sent to one endpoint that re-authorizes
 * each order against this user's branch assignments.
 */
export function ApprovalQueue() {
  const { toast } = useToast()
  const [filter, setFilter] = useState<ApprovalFilter>("pending")
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null)
  const [rejectReason, setRejectReason] = useState("")
  const [busy, setBusy] = useState(false)

  const { data, error, isLoading, isValidating, mutate } = useSWR<ApprovalQueueResponse>(
    `/api/v1/group-portal/approvals?page=${page}&filter=${filter}`,
    fetcher,
    { revalidateOnFocus: true, keepPreviousData: true },
  )

  const items = useMemo(() => data?.items ?? [], [data])
  const summary = data?.summary
  const pagination = data?.pagination

  const toggleExpanded = useCallback((id: number) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelection = useCallback((orderId: number) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(orderId)) next.delete(orderId)
      else next.add(orderId)
      return next
    })
  }, [])

  const selectAllPending = useCallback((orderIds: number[], selectAll: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const orderId of orderIds) {
        if (selectAll) next.add(orderId)
        else next.delete(orderId)
      }
      return next
    })
  }, [])

  const requestDecision = useCallback((orderIds: number[], decision: "approve" | "reject") => {
    if (orderIds.length === 0) return
    setRejectReason("")
    setPendingDecision({ orderIds, decision })
  }, [])

  const submitDecision = useCallback(async () => {
    if (!pendingDecision) return
    const { orderIds, decision } = pendingDecision

    if (decision === "reject" && rejectReason.trim().length === 0) return

    setBusy(true)
    try {
      const res = await fetch("/api/v1/group-portal/approvals/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          orderIds,
          ...(decision === "reject" ? { reason: rejectReason.trim() } : {}),
        }),
      })
      const payload: DecisionResponse & { error?: string } = await res.json().catch(() => ({} as any))

      if (!res.ok) {
        toast({
          title: "Decision not applied",
          description: payload?.error || "Please try again.",
          variant: "destructive",
        })
        return
      }

      // A partially applicable selection still does the work it legitimately
      // can, so the failed rows are surfaced rather than silently dropped.
      if (payload.failed > 0) {
        const firstFailure = payload.results?.find((result) => !result.ok)
        toast({
          title: payload.message,
          description: firstFailure?.message
            ? `${payload.failed} could not be applied — ${firstFailure.message}`
            : `${payload.failed} could not be applied.`,
          variant: "destructive",
        })
      } else {
        toast({ title: payload.message })
      }

      setSelectedIds((current) => {
        const next = new Set(current)
        for (const orderId of orderIds) next.delete(orderId)
        return next
      })
      setPendingDecision(null)
      setRejectReason("")
      await mutate()
    } catch {
      toast({
        title: "Decision not applied",
        description: "Check your connection and try again.",
        variant: "destructive",
      })
    } finally {
      setBusy(false)
    }
  }, [mutate, pendingDecision, rejectReason, toast])

  const changeFilter = useCallback((next: ApprovalFilter) => {
    setFilter(next)
    setPage(1)
    setSelectedIds(new Set())
  }, [])

  const totalPages = Math.max(1, pagination?.totalPages ?? 1)

  return (
    <div className="space-y-6">
      <section aria-label="Approval summary" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          label="Awaiting decision"
          value={summary?.pendingOrders ?? 0}
          icon={<Clock className="h-4 w-4" />}
          tone="bg-gradient-to-br from-amber-50 to-orange-50/50 border-amber-100 dark:from-amber-950/40 dark:to-orange-900/20 dark:border-amber-900/50"
          accent="text-amber-600 dark:text-amber-400"
        />
        <StatCard
          label="Group orders pending"
          value={summary?.pendingGroupOrders ?? 0}
          icon={<Inbox className="h-4 w-4" />}
          tone="bg-gradient-to-br from-indigo-50 to-blue-50/50 border-indigo-100 dark:from-indigo-950/40 dark:to-blue-900/20 dark:border-indigo-900/50"
          accent="text-indigo-600 dark:text-indigo-400"
        />
        <StatCard
          label="Approved"
          value={summary?.approvedOrders ?? 0}
          icon={<CheckCircle2 className="h-4 w-4" />}
          tone="bg-gradient-to-br from-emerald-50 to-teal-50/50 border-emerald-100 dark:from-emerald-950/40 dark:to-teal-900/20 dark:border-emerald-900/50"
          accent="text-emerald-600 dark:text-emerald-400"
        />
        <StatCard
          label="Rejected"
          value={summary?.rejectedOrders ?? 0}
          icon={<XCircle className="h-4 w-4" />}
          tone="bg-gradient-to-br from-rose-50 to-pink-50/50 border-rose-100 dark:from-rose-950/40 dark:to-pink-900/20 dark:border-rose-900/50"
          accent="text-rose-600 dark:text-rose-400"
        />
        <StatCard
          label="Branches in scope"
          value={summary?.branchesInScope ?? 0}
          icon={<Building2 className="h-4 w-4" />}
          tone="bg-gradient-to-br from-slate-50 to-slate-100/50 border-slate-200 dark:from-slate-900/60 dark:to-slate-800/30 dark:border-slate-800"
          accent="text-slate-600 dark:text-slate-300"
        />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex items-center rounded-xl border border-slate-200/60 bg-slate-100/60 p-1 dark:border-slate-700/50 dark:bg-slate-800/50"
          role="group"
          aria-label="Filter group orders"
        >
          {([["pending", "Awaiting decision"], ["all", "All group orders"]] as [ApprovalFilter, string][]).map(
            ([value, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={filter === value ? "secondary" : "ghost"}
                aria-pressed={filter === value}
                onClick={() => changeFilter(value)}
                className={cn(
                  "h-8 rounded-lg px-3 text-xs font-bold",
                  filter === value
                    ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white"
                    : "text-slate-500 hover:text-slate-900 dark:text-slate-400",
                )}
              >
                {label}
              </Button>
            ),
          )}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => mutate()}
          className="h-8 gap-2 rounded-full"
        >
          <RefreshCw className={cn("h-3.5 w-3.5 text-slate-500", isValidating && "animate-spin text-indigo-500")} />
          Refresh
        </Button>
      </div>

      <QueueBody
        error={Boolean(error)}
        loading={isLoading && !data}
        isEmpty={items.length === 0}
        filter={filter}
      >
        <div className="space-y-4">
          {items.map((item) => (
            <ApprovalGroupCard
              key={item.id}
              item={item}
              expanded={expanded.has(item.id)}
              onToggleExpanded={() => toggleExpanded(item.id)}
              selectedIds={selectedIds}
              onToggleSelection={toggleSelection}
              onSelectAllPending={selectAllPending}
              onDecide={requestDecision}
              busy={busy}
            />
          ))}
        </div>
      </QueueBody>

      {(pagination?.total ?? 0) > 0 && (
        <div className="flex flex-col items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-slate-800 sm:flex-row">
          <p className="text-xs font-medium text-slate-500" aria-live="polite">
            Page {page} of {totalPages} — {pagination?.total} group order
            {pagination?.total === 1 ? "" : "s"}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1 rounded-xl"
              disabled={page <= 1 || isValidating}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1 rounded-xl"
              disabled={page >= totalPages || isValidating}
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <DecisionDialog
        pendingDecision={pendingDecision}
        rejectReason={rejectReason}
        onReasonChange={setRejectReason}
        onCancel={() => setPendingDecision(null)}
        onConfirm={submitDecision}
        busy={busy}
      />
    </div>
  )
}

function QueueBody({
  error,
  loading,
  isEmpty,
  filter,
  children,
}: Readonly<{
  error: boolean
  loading: boolean
  isEmpty: boolean
  filter: ApprovalFilter
  children: React.ReactNode
}>) {
  if (loading) {
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
          The approval queue could not be loaded. Please try again, or contact your administrator
          if this continues.
        </CardContent>
      </Card>
    )
  }

  if (isEmpty) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="p-10 text-center">
          <ClipboardCheck className="mx-auto mb-3 h-9 w-9 text-slate-300 dark:text-slate-700" />
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
            {filter === "pending" ? "Nothing is waiting on you" : "No group orders yet"}
          </p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {filter === "pending"
              ? "Group orders needing your decision will appear here."
              : "Group orders raised for your branches will appear here."}
          </p>
        </CardContent>
      </Card>
    )
  }

  return <>{children}</>
}

function DecisionDialog({
  pendingDecision,
  rejectReason,
  onReasonChange,
  onCancel,
  onConfirm,
  busy,
}: Readonly<{
  pendingDecision: PendingDecision | null
  rejectReason: string
  onReasonChange: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
  busy: boolean
}>) {
  const isReject = pendingDecision?.decision === "reject"
  const count = pendingDecision?.orderIds.length ?? 0
  const reasonMissing = isReject && rejectReason.trim().length === 0

  return (
    <Dialog open={Boolean(pendingDecision)} onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isReject ? "Reject" : "Approve"} {count} order{count === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            {isReject
              ? "The requester is notified and any held budget is released back to the branch."
              : "Each approved order gets a fulfilment token you can send to admin operations for delivery."}
          </DialogDescription>
        </DialogHeader>

        {isReject && (
          <div className="space-y-2">
            <label htmlFor="rejection-reason" className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Reason for rejection
            </label>
            <Textarea
              id="rejection-reason"
              value={rejectReason}
              maxLength={REJECTION_REASON_MAX}
              onChange={(event) => onReasonChange(event.target.value)}
              placeholder="Explain why these orders are being rejected"
              className="min-h-24"
            />
            <p className="text-xs text-slate-400">
              This reason is recorded against every order in this decision.
            </p>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={busy || reasonMissing}
            className={cn(
              isReject
                ? "bg-rose-600 text-white hover:bg-rose-500"
                : "bg-emerald-600 text-white hover:bg-emerald-500",
            )}
          >
            {(() => {
              if (busy) return "Working…"
              return isReject ? "Reject orders" : "Approve orders"
            })()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StatCard({
  label,
  value,
  icon,
  tone,
  accent,
}: Readonly<{
  label: string
  value: number
  icon: React.ReactNode
  tone: string
  accent: string
}>) {
  return (
    <Card className={cn("rounded-2xl border shadow-sm", tone)}>
      <CardContent className="flex items-center justify-between gap-2 p-4">
        <div className="min-w-0">
          <p className="truncate text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            {label}
          </p>
          <p className="mt-1 text-2xl font-black leading-none text-slate-900 dark:text-white">{value}</p>
        </div>
        <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/60 dark:bg-slate-900/50", accent)}>
          {icon}
        </span>
      </CardContent>
    </Card>
  )
}
