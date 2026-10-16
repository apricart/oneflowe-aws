"use client"

import { useEffect, useState } from "react"

import { Loader2 } from "lucide-react"

import type { HeadCountRequestListItem } from "@/components/branch-head-count/head-count-request-row"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { MAX_HEAD_COUNT_REQUEST_REASON, formatBranchHeadCount } from "@/lib/branch-head-count"
import { jsonFetcher } from "@/lib/fetcher"

/**
 * Head Office approving or rejecting one request. Approving writes the
 * requested figure to the branch. The figure is shown read-only: an approver
 * who wants a different number rejects and sets it on the branch directly, so
 * an approval is always of what the branch asked for.
 */
export function HeadCountDecisionDialog({
  request,
  onClose,
  onDecided,
}: Readonly<{
  request: HeadCountRequestListItem | null
  onClose: () => void
  onDecided: () => void
}>) {
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    setReason("")
    setFailure(null)
    setBusy(null)
  }, [request])

  const decide = async (decision: "approve" | "reject") => {
    if (!request || busy) return
    setFailure(null)
    setBusy(decision)
    try {
      const body: Record<string, unknown> = { decision }
      if (reason.trim()) body.reason = reason.trim()
      await jsonFetcher(`/api/v1/branch-head-count-requests/${request.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      })
      onDecided()
      onClose()
    } catch (caughtError: any) {
      setFailure(caughtError?.message || "The decision could not be recorded. Please try again.")
    } finally {
      setBusy(null)
    }
  }

  if (!request) return null
  const branchName = request.branchName ?? `Branch ${request.branchId}`

  return (
    <Dialog open onOpenChange={(open) => { if (!open && busy === null) onClose() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Head count for {branchName}</DialogTitle>
          <DialogDescription>
            Approving sets this branch&apos;s head count to {formatBranchHeadCount(request.requestedHeadCount)}.
            Rejecting changes nothing.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-900">
          <dt className="font-medium text-slate-500">Branch</dt>
          <dd className="text-slate-900 dark:text-slate-100">{branchName}</dd>
          <dt className="font-medium text-slate-500">Current</dt>
          <dd className="text-slate-900 dark:text-slate-100">{formatBranchHeadCount(request.branchHeadCount)}</dd>
          <dt className="font-medium text-slate-500">Requested</dt>
          <dd className="font-semibold text-slate-900 dark:text-slate-100">
            {formatBranchHeadCount(request.requestedHeadCount)}
          </dd>
          {request.requestedByName && (
            <>
              <dt className="font-medium text-slate-500">Requested by</dt>
              <dd className="text-slate-900 dark:text-slate-100">{request.requestedByName}</dd>
            </>
          )}
          {request.requestReason && (
            <>
              <dt className="font-medium text-slate-500">Reason</dt>
              <dd className="text-slate-900 dark:text-slate-100">{request.requestReason}</dd>
            </>
          )}
        </dl>

        {request.currentHeadCount !== request.branchHeadCount && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            The head count changed after this was requested (it was{" "}
            {formatBranchHeadCount(request.currentHeadCount)}).
          </p>
        )}

        <div className="space-y-2">
          <Label htmlFor="head-count-decision-reason">Note (optional)</Label>
          <Textarea
            id="head-count-decision-reason"
            value={reason}
            maxLength={MAX_HEAD_COUNT_REQUEST_REASON}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Recorded against the decision and shown to the branch."
            rows={3}
          />
        </div>

        {failure && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {failure}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" disabled={busy !== null} onClick={() => decide("reject")}>
            {busy === "reject" && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Reject
          </Button>
          <Button type="button" disabled={busy !== null} onClick={() => decide("approve")}>
            {busy === "approve" && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
