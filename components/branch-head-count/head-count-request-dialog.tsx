"use client"

import { useEffect, useState } from "react"

import { Loader2 } from "lucide-react"

import { BranchHeadCountField } from "@/components/branches/branch-head-count-field"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  MAX_HEAD_COUNT_REQUEST_REASON,
  formatBranchHeadCount,
  parseHeadCountInput,
} from "@/lib/branch-head-count"
import { jsonFetcher } from "@/lib/fetcher"

/**
 * A Branch Admin or Group User asking Head Office to set a branch's head
 * count. Nothing changes on the branch until Head Office approves; the dialog
 * says so. The branch options come from the list endpoint, which resolves them
 * from the session, and the endpoint re-checks the chosen branch anyway.
 */
export type HeadCountRequestableBranch = { id: number; name: string; headCount: number | null }

export function HeadCountRequestDialog({
  open,
  branches,
  onOpenChange,
  onRequested,
}: Readonly<{
  open: boolean
  branches: HeadCountRequestableBranch[]
  onOpenChange: (open: boolean) => void
  onRequested: () => void
}>) {
  const [branchId, setBranchId] = useState("")
  const [headCountText, setHeadCountText] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setHeadCountText("")
    setReason("")
    setFailure(null)
    setBusy(false)
    setBranchId(branches.length === 1 ? String(branches[0].id) : "")
  }, [open, branches])

  const chosen = branches.find((branch) => String(branch.id) === branchId) ?? null
  const headCount = parseHeadCountInput(headCountText)

  const submit = async (event: React.SubmitEvent) => {
    event.preventDefault()
    if (busy) return
    if (!chosen) {
      setFailure("Choose the branch this head count is for.")
      return
    }
    if (headCount === undefined || headCount === null) {
      setFailure("Enter how many people work at the branch.")
      return
    }

    setFailure(null)
    setBusy(true)
    try {
      await jsonFetcher("/api/v1/branch-head-count-requests", {
        method: "POST",
        body: JSON.stringify({
          branchId: chosen.id,
          headCount,
          reason: reason.trim() || null,
        }),
      })
      onRequested()
      onOpenChange(false)
    } catch (caughtError: any) {
      setFailure(caughtError?.message || "The request could not be sent. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Request a head count change</DialogTitle>
            <DialogDescription>
              Head Office has to approve this before the branch&apos;s head count changes. Until
              then it stays on your list as waiting.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="head-count-request-branch">Branch</Label>
            <Select value={branchId} onValueChange={setBranchId} disabled={branches.length <= 1}>
              <SelectTrigger id="head-count-request-branch">
                <SelectValue placeholder="Choose a branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((branch) => (
                  <SelectItem key={branch.id} value={String(branch.id)}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {chosen && (
              <p className="text-xs text-muted-foreground">
                Current head count: {formatBranchHeadCount(chosen.headCount)}
              </p>
            )}
          </div>

          <BranchHeadCountField
            id="head-count-request-value"
            label="New head count"
            hint="How many people work at this branch now."
            value={headCountText}
            onChange={setHeadCountText}
            disabled={busy}
          />

          <div className="space-y-2">
            <Label htmlFor="head-count-request-reason">Why is it changing? (optional)</Label>
            <Textarea
              id="head-count-request-reason"
              value={reason}
              maxLength={MAX_HEAD_COUNT_REQUEST_REASON}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              placeholder="Shown to Head Office when they review this."
              disabled={busy}
            />
          </div>

          {failure && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {failure}
            </p>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || headCount === undefined || headCount === null || !chosen}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Send for approval
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
