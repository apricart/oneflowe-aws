"use client"

import { useState } from "react"
import { Loader2, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { usePaymentControl } from "@/lib/hooks/use-payment-control"
import { PAYMENT_CONTROL_POLICY } from "@/lib/payment-control-policy"
import type { PaymentControlView } from "@/lib/payment-control-view"
import { formatDateTime } from "@/lib/utils"

import { PaymentControlTimeline } from "./payment-control-timeline"

const STATE_LABELS: Record<PaymentControlView["state"], { label: string; className: string }> = {
  NOT_CONFIGURED: { label: "No payment data connected", className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200" },
  CLEAR: { label: "Clear", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" },
  WARNING: { label: "Warning", className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200" },
  BLOCKED: { label: "Ordering blocked", className: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200" },
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error || "Request failed")
  return payload as PaymentControlView
}

function useExceptionDialog({
  branchId,
  view,
  mutate,
  onChanged,
}: {
  branchId: number
  view: PaymentControlView | undefined
  mutate: ReturnType<typeof usePaymentControl>["mutate"]
  onChanged?: () => void
}) {
  const { toast } = useToast()
  const [dialog, setDialog] = useState<"grant" | "revoke" | null>(null)
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const close = () => {
    if (submitting) return
    setDialog(null)
    setReason("")
  }

  const submit = async () => {
    if (!view || !dialog) return
    setSubmitting(true)
    try {
      const trimmed = reason.trim()
      const updated = dialog === "grant"
        ? await postJson("/api/v1/payment-control/exceptions", trimmed ? { branchId, reason: trimmed } : { branchId })
        : await postJson(`/api/v1/payment-control/exceptions/${view.exception?.id}/revoke`, trimmed ? { reason: trimmed } : {})
      await mutate(updated, { revalidate: false })
      onChanged?.()
      toast({
        title: dialog === "grant" ? "Exception granted" : "Exception revoked",
        description: dialog === "grant" && updated.exception
          ? `Ordering is allowed for ${updated.branch.name} until ${formatDateTime(updated.exception.expiresAt)}.`
          : `Normal overdue-payment rules apply to ${updated.branch.name} again.`,
      })
      setDialog(null)
      setReason("")
    } catch (submitError) {
      await mutate()
      toast({
        title: dialog === "grant" ? "Could not grant the exception" : "Could not revoke the exception",
        description: submitError instanceof Error ? submitError.message : "Please try again.",
        variant: "destructive",
      })
    } finally {
      setSubmitting(false)
    }
  }

  return { close, dialog, reason, setDialog, setReason, submit, submitting }
}

function PaymentControlHeader({ view, openDialog }: {
  view: PaymentControlView
  openDialog: (dialog: "grant" | "revoke") => void
}) {
  const state = STATE_LABELS[view.state]
  const canGrant = view.canManageExceptions && !view.exceptionActive
  const canRevoke = view.canManageExceptions && view.exceptionActive && view.exception !== null
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={state.className}>{state.label}</Badge>
        {view.configured && (
          <span className="text-sm text-muted-foreground">
            {view.overdueCount} of {view.threshold} overdue{view.limitReached ? " · limit reached" : ""}
          </span>
        )}
        <Badge variant="outline" className={view.orderingAllowed ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}>
          {view.orderingAllowed ? "Ordering allowed" : "Ordering stopped"}
        </Badge>
        {view.exceptionActive && <Badge variant="outline" className="text-indigo-700 dark:text-indigo-300">Exception active</Badge>}
      </div>
      {view.canManageExceptions && (
        <div className="flex gap-2">
          {canGrant && (
            <Button type="button" size="sm" variant="outline" className="gap-1" onClick={() => openDialog("grant")}>
              <ShieldCheck className="h-4 w-4" /> Grant exception
            </Button>
          )}
          {canRevoke && (
            <Button type="button" size="sm" variant="outline" className="gap-1 text-rose-600" onClick={() => openDialog("revoke")}>
              <ShieldOff className="h-4 w-4" /> Revoke exception
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function PaymentControlException({ exception }: { exception: NonNullable<PaymentControlView["exception"]> }) {
  const statusLabel = exception.active
    ? "Head Office exception in force"
    : exception.revokedAt ? "Exception revoked" : "Exception expired"
  return (
    <div className="rounded-xl border p-3 text-sm dark:border-slate-700" data-testid="payment-control-exception">
      <div className="flex items-start gap-2">
        {exception.active ? <ShieldCheck className="mt-0.5 h-4 w-4 text-indigo-600" /> : <ShieldAlert className="mt-0.5 h-4 w-4 text-slate-500" />}
        <div className="space-y-1">
          <p className="font-medium">{statusLabel}</p>
          <p className="text-xs text-muted-foreground">
            From {formatDateTime(exception.startAt)} to {formatDateTime(exception.expiresAt)}
            {exception.grantedBy ? ` · granted by ${exception.grantedBy.name || "Head Office"}` : ""}
          </p>
          {exception.reason && <p className="text-xs text-muted-foreground">Reason: {exception.reason}</p>}
          {exception.revokedAt && (
            <p className="text-xs text-muted-foreground">
              Revoked {formatDateTime(exception.revokedAt)}{exception.revokeReason ? ` · ${exception.revokeReason}` : ""}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The Head Office view of one branch: its state, its timeline, the exception
 * on file, and — for a caller the server says may manage exceptions — the
 * grant and revoke actions, each behind a confirmation that spells out what
 * it does and for how long. The buttons are convenience; the server enforces.
 */
export function PaymentControlPanel({ branchId, onChanged }: { branchId: number; onChanged?: () => void }) {
  const { data: view, error, isLoading, mutate } = usePaymentControl(branchId)
  const { close, dialog, reason, setDialog, setReason, submit, submitting } = useExceptionDialog({
    branchId,
    view,
    mutate,
    onChanged,
  })

  if (isLoading && !view) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="payment-control-panel-loading">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading payment status
      </div>
    )
  }
  if (error || !view) {
    return (
      <p className="text-sm text-rose-600" data-testid="payment-control-panel-error">
        {error?.message || "Unable to load payment status"}
      </p>
    )
  }

  const exception = view.exception

  return (
    <div className="space-y-4" data-testid="payment-control-panel" data-state={view.state}>
      <PaymentControlHeader view={view} openDialog={setDialog} />
          {/* Summary moved to PaymentControlHeader.
            <span className="text-sm text-muted-foreground">
              {view.overdueCount} of {view.threshold} overdue{view.limitReached ? " · limit reached" : ""}
            </span>
          */}

      {!view.configured && (
        <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground" data-testid="payment-control-not-configured">
          No overdue-payment data source is connected yet, so ordering for this branch is not restricted by payment
          status. An exception recorded now takes effect automatically once payment data is connected, and expires on
          its date either way.
        </p>
      )}

      {exception && <PaymentControlException exception={exception} />}
      {/* Exception details moved to PaymentControlException.
        <div className="rounded-xl border p-3 text-sm dark:border-slate-700" data-testid="payment-control-exception">
          <div className="flex items-start gap-2">
            {exception.active ? <ShieldCheck className="mt-0.5 h-4 w-4 text-indigo-600" /> : <ShieldAlert className="mt-0.5 h-4 w-4 text-slate-500" />}
            <div className="space-y-1">
              <p className="font-medium">
                {exception.active ? "Head Office exception in force" : exception.revokedAt ? "Exception revoked" : "Exception expired"}
              </p>
              <p className="text-xs text-muted-foreground">
                From {formatDateTime(exception.startAt)} to {formatDateTime(exception.expiresAt)}
                {exception.grantedBy ? ` · granted by ${exception.grantedBy.name || "Head Office"}` : ""}
              </p>
              {exception.reason && <p className="text-xs text-muted-foreground">Reason: {exception.reason}</p>}
              {exception.revokedAt && (
                <p className="text-xs text-muted-foreground">
                  Revoked {formatDateTime(exception.revokedAt)}{exception.revokeReason ? ` · ${exception.revokeReason}` : ""}
                </p>
              )}
            </div>
          </div>
        </div>
      */}

      {view.timeline.length > 0 && <PaymentControlTimeline steps={view.timeline} />}

      <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) close() }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog === "grant" ? "Grant an exceptional allowance" : "Revoke the exception"}</DialogTitle>
            <DialogDescription>
              {dialog === "grant"
                ? `This lets ${view.branch.name} keep placing orders for ${PAYMENT_CONTROL_POLICY.exceptionDurationMonths === 1 ? "one month" : `${PAYMENT_CONTROL_POLICY.exceptionDurationMonths} months`} from now although its overdue payments are unresolved. It is an exception, not a clearance: the overdue payments remain, and when it ends the normal rules apply again automatically. The grant is recorded in the audit trail under your name.`
                : `Ordering for ${view.branch.name} stops again immediately if its overdue payments are still over the limit. The revocation is recorded in the audit trail under your name.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="payment-control-reason">Reason (optional)</Label>
            <Textarea
              id="payment-control-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={1000}
              rows={3}
              placeholder={dialog === "grant" ? "e.g. Payment confirmed by finance, clearing next week" : "e.g. Granted in error"}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close} disabled={submitting}>Cancel</Button>
            <Button
              type="button"
              variant={dialog === "grant" ? "default" : "destructive"}
              onClick={() => { void submit() }}
              disabled={submitting}
            >
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {dialog === "grant" ? "Grant exception" : "Revoke exception"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
