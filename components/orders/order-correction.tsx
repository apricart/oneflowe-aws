"use client"

import { useState } from "react"
import { format } from "date-fns"
import { CornerUpLeft, Loader2, Send } from "lucide-react"

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
import { toast } from "@/hooks/use-toast"
import { ORDER_CORRECTION_TEXT_MAX_LENGTH } from "@/lib/order-correction"

/**
 * The shared pieces of "return for correction" — see
 * plans/OF-ORDER-RETURN-for-correction.md.
 *
 * Presentation only. Whether the viewer may return or resubmit is decided by
 * the server on every request; the callers show these controls from the
 * capabilities and state the server already returned.
 */

function formatWhen(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : format(date, "dd MMM yyyy, HH:mm")
}

/** The open request: what the approver asked to be corrected. */
export function OrderCorrectionNotice({
  comment,
  returnedAt,
  audience,
  className,
}: Readonly<{
  comment: string | null | undefined
  returnedAt?: string | Date | null
  /** Who is reading: the requester is told what to do next, the approver what it is waiting for. */
  audience: "requester" | "approver"
  className?: string
}>) {
  if (!comment) return null
  const when = formatWhen(returnedAt)
  return (
    <div
      role="status"
      className={
        "rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 "
        + "dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200 "
        + (className ?? "")
      }
    >
      <p className="mb-1 flex items-center gap-1.5 font-bold uppercase tracking-wider">
        <CornerUpLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Returned for correction{when ? ` · ${when}` : ""}
      </p>
      <p className="whitespace-pre-line text-sm">{comment}</p>
      <p className="mt-2 text-[11px] opacity-80">
        {audience === "requester"
          ? "Edit the order as requested, then resubmit it for approval. The order stays reserved until then."
          : "Waiting for the requester to correct and resubmit. It cannot be approved until then, but it can still be rejected."}
      </p>
    </div>
  )
}

export type OrderCorrectionHistoryEntry = {
  id: number
  comment: string
  requestedAt: string
  requestedByName: string | null
  requestedByRole: string
  resolution: "RESUBMITTED" | "REJECTED" | null
  resolvedAt: string | null
  resolvedByName: string | null
  resolvedByRole: string | null
  responseNote: string | null
}

const ROLE_LABELS: Record<string, string> = {
  BRANCH_ADMIN: "Branch Admin",
  HEAD_OFFICE: "Head Office",
  GROUP_USER: "Group User",
  ORDER_PORTAL: "Order Portal",
  GROUP_ORDER_PORTAL: "Group Order Portal",
}

function who(name: string | null, role: string | null): string {
  const label = role ? (ROLE_LABELS[role] ?? role) : null
  if (name && label) return `${name} (${label})`
  return name || label || "Unknown"
}

/** Every round on the order, oldest first. Renders nothing for an order never returned. */
export function OrderCorrectionHistory({
  entries,
}: Readonly<{ entries: OrderCorrectionHistoryEntry[] | null | undefined }>) {
  if (!entries || entries.length === 0) return null
  return (
    <section aria-label="Correction history" className="space-y-2">
      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        Correction history
      </h3>
      <ol className="space-y-2">
        {entries.map((entry, index) => (
          <li
            key={entry.id}
            className="rounded-xl border border-slate-200 p-3 text-xs dark:border-slate-800"
          >
            <p className="font-semibold text-slate-700 dark:text-slate-200">
              Round {index + 1} · returned by {who(entry.requestedByName, entry.requestedByRole)}
              {formatWhen(entry.requestedAt) ? ` on ${formatWhen(entry.requestedAt)}` : ""}
            </p>
            <p className="mt-1 whitespace-pre-line text-slate-600 dark:text-slate-300">{entry.comment}</p>
            {entry.resolution === null && (
              <p className="mt-2 font-medium text-amber-700 dark:text-amber-300">Awaiting correction</p>
            )}
            {entry.resolution === "RESUBMITTED" && (
              <div className="mt-2 text-emerald-700 dark:text-emerald-300">
                <p className="font-medium">
                  Resubmitted by {who(entry.resolvedByName, entry.resolvedByRole)}
                  {formatWhen(entry.resolvedAt) ? ` on ${formatWhen(entry.resolvedAt)}` : ""}
                </p>
                {entry.responseNote && (
                  <p className="mt-1 whitespace-pre-line text-slate-600 dark:text-slate-300">
                    {entry.responseNote}
                  </p>
                )}
              </div>
            )}
            {entry.resolution === "REJECTED" && (
              <p className="mt-2 font-medium text-rose-700 dark:text-rose-300">
                Closed — order rejected by {who(entry.resolvedByName, entry.resolvedByRole)}
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}

async function postJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result?.error || "The request could not be completed")
}

/**
 * The approver's dialog. A comment is required; it is what the requester is
 * shown and what they are expected to act on.
 */
export function ReturnForCorrectionDialog({
  order,
  onClose,
  onReturned,
}: Readonly<{
  order: { id: number; tid: string } | null
  onClose: () => void
  onReturned: () => void
}>) {
  const [comment, setComment] = useState("")
  const [busy, setBusy] = useState(false)
  const trimmed = comment.trim()

  const close = () => {
    if (busy) return
    setComment("")
    onClose()
  }

  const submit = async () => {
    if (!order || !trimmed || busy) return
    setBusy(true)
    try {
      await postJson(`/api/v1/orders/${order.id}/return-for-correction`, { comment: trimmed })
      toast({ title: "Order returned", description: `Order ${order.tid} was sent back for correction.` })
      setComment("")
      onReturned()
      onClose()
    } catch (error) {
      toast({
        title: "Could not return the order",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={order !== null} onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Return order for correction</DialogTitle>
          <DialogDescription>
            Order {order?.tid} goes back to its requester with your comment. It stays reserved
            while they correct it, and comes back to you when they resubmit.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="order-correction-comment">What needs correcting</Label>
          <Textarea
            id="order-correction-comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            maxLength={ORDER_CORRECTION_TEXT_MAX_LENGTH}
            rows={4}
            placeholder="e.g. Reduce the quantity of paper to 5 reams"
            aria-required="true"
          />
          <p className="text-right text-[11px] text-muted-foreground">
            {comment.length}/{ORDER_CORRECTION_TEXT_MAX_LENGTH}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={busy}>Cancel</Button>
          <Button
            type="button"
            onClick={() => { void submit() }}
            disabled={busy || !trimmed}
            className="bg-amber-600 text-white hover:bg-amber-500"
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CornerUpLeft className="mr-2 h-4 w-4" />}
            Return for correction
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The requester's dialog. The note is optional — the correction may be the edit itself. */
export function ResubmitOrderDialog({
  order,
  onClose,
  onResubmitted,
}: Readonly<{
  order: { id: number; tid: string; correctionRequestNote?: string | null } | null
  onClose: () => void
  onResubmitted: () => void
}>) {
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  const close = () => {
    if (busy) return
    setNote("")
    onClose()
  }

  const submit = async () => {
    if (!order || busy) return
    setBusy(true)
    try {
      const trimmed = note.trim()
      await postJson(`/api/v1/orders/${order.id}/resubmit`, trimmed ? { note: trimmed } : {})
      toast({ title: "Order resubmitted", description: `Order ${order.tid} is back with the approver.` })
      setNote("")
      onResubmitted()
      onClose()
    } catch (error) {
      toast({
        title: "Could not resubmit the order",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={order !== null} onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Resubmit order for approval</DialogTitle>
          <DialogDescription>
            Make sure order {order?.tid} has been edited as requested before sending it back.
          </DialogDescription>
        </DialogHeader>
        {order?.correctionRequestNote && (
          <OrderCorrectionNotice comment={order.correctionRequestNote} audience="requester" />
        )}
        <div className="space-y-2">
          <Label htmlFor="order-resubmission-note">Note to the approver (optional)</Label>
          <Textarea
            id="order-resubmission-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={ORDER_CORRECTION_TEXT_MAX_LENGTH}
            rows={3}
            placeholder="e.g. Quantity reduced as asked"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={() => { void submit() }} disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            Resubmit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
