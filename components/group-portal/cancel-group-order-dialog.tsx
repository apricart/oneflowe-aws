"use client"

import { useState } from "react"
import { Ban, Loader2 } from "lucide-react"

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
import { GROUP_ORDER_CANCEL_REASON_MAX_LENGTH } from "@/lib/group-order-cancel"

/**
 * What is being cancelled: one branch order, or every still-pending branch
 * order of one group submission.
 */
export type GroupCancelTarget =
  | { kind: "order"; orderId: number; tid: string }
  | { kind: "submission"; groupOrderId: number; reference: string; pendingCount: number }

function endpointFor(target: GroupCancelTarget): string {
  return target.kind === "order"
    ? `/api/v1/group-portal/branch-orders/${target.orderId}/cancel`
    : `/api/v1/group-portal/orders/${target.groupOrderId}/cancel`
}

/**
 * Ask for a reason, then cancel. Approval is the line: the server cancels only
 * what is still pending and says so when nothing is
 * (`plans/OF-GROUP-cancel-pending-group-orders.md`). The form never decides
 * that on its own — a screen can be stale.
 */
export function CancelGroupOrderDialog({
  target,
  onClose,
  onCancelled,
}: Readonly<{
  target: GroupCancelTarget | null
  onClose: () => void
  onCancelled: () => void
}>) {
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const trimmed = reason.trim()

  const close = () => {
    if (busy) return
    setReason("")
    onClose()
  }

  const submit = async () => {
    if (!target || busy || trimmed.length === 0) return
    setBusy(true)
    try {
      const response = await fetch(endpointFor(target), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: trimmed }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast({
          title: "Not cancelled",
          description: payload?.error || "Please try again.",
          variant: "destructive",
        })
        // Something moved under the screen (approved meanwhile, or nothing
        // pending any more) — refresh it so it shows what is true now.
        if (response.status === 409) onCancelled()
        return
      }
      toast({
        title: target.kind === "order" ? "Order cancelled" : "Pending orders cancelled",
        description: target.kind === "order"
          ? `Order ${target.tid} was cancelled and its budget released.`
          : payload?.message || `Pending orders in ${target.reference} were cancelled.`,
      })
      setReason("")
      onCancelled()
      onClose()
    } catch {
      toast({
        title: "Not cancelled",
        description: "Check your connection and try again.",
        variant: "destructive",
      })
    } finally {
      setBusy(false)
    }
  }

  const title = target?.kind === "submission" ? "Cancel pending orders" : "Cancel order"
  const description = (() => {
    if (!target) return ""
    if (target.kind === "order") {
      return `Order ${target.tid} has not been approved yet. Cancelling it releases its budget and stock. This cannot be undone.`
    }
    const count = target.pendingCount
    return `${count} branch order${count === 1 ? "" : "s"} in ${target.reference} ${count === 1 ? "is" : "are"} still waiting for approval and will be cancelled. Orders already approved are not affected. This cannot be undone.`
  })()

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="group-order-cancel-reason">Reason for cancelling</Label>
          <Textarea
            id="group-order-cancel-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={GROUP_ORDER_CANCEL_REASON_MAX_LENGTH}
            rows={3}
            required
            aria-required="true"
            placeholder="e.g. Ordered by mistake"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={busy}>Keep order</Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => { void submit() }}
            disabled={busy || trimmed.length === 0}
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Ban className="mr-2 h-4 w-4" />}
            {title}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
