"use client"

import { useState } from "react"
import { Copy, Mail, ShieldCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { TOKEN_SENT_LABEL, readTokenSendRefusal } from "@/lib/order-token-handoff"

/**
 * The fulfilment token and its hand-off to admin operations.
 *
 * The token is the credential a Super Admin needs to mark an order delivered,
 * so it is only ever rendered for an order the signed-in user may already see
 * and that is already approved. Both group roles reach this panel: the approver
 * from its queue, and the requester from its own group order history. Neither
 * gains reach here — the server decides whether a token is returned at all, and
 * `/api/v1/orders/[id]/send-token-email` re-authorizes the caller from scratch
 * before it sends anything.
 *
 * It is one component rather than two so the wording, the audit trail, and the
 * failure handling cannot drift apart between the two surfaces.
 *
 * Emailing the token is half of what settles the order; the goods still have to
 * arrive. The server marks the order fulfilled if it has already been
 * delivered, and otherwise remembers the hand-off so the delivery settles it.
 * It reports back which of the two happened, so the panel can say what actually
 * happened instead of promising it.
 */

/** What the hand-off did, in the words the server reported it in. */
function handoffOutcome(payload: { fulfilled?: boolean; awaitingDelivery?: boolean }): string {
  if (payload?.fulfilled) return "the order is now marked fulfilled."
  if (payload?.awaitingDelivery) return "it will be marked fulfilled once the admin records delivery."
  return "the admin can now mark this order delivered."
}
export function TokenHandoff({
  orderId,
  tid,
  token,
  branchName,
  onFulfilled,
}: Readonly<{
  orderId: number
  tid: string
  token: string
  branchName?: string
  /** Called once the order has moved on — settled by this hand-off, or found already settled — so the surface can refresh. */
  onFulfilled?: () => void
}>) {
  const { toast } = useToast()
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const label = branchName ? `${tid} · ${branchName}` : tid

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(token)
      toast({ title: "Token copied", description: `Fulfilment token for ${label}` })
    } catch {
      toast({
        title: "Could not copy",
        description: "Copy the token manually from the field.",
        variant: "destructive",
      })
    }
  }

  const sendToken = async () => {
    setSending(true)
    try {
      const res = await fetch(`/api/v1/orders/${orderId}/send-token-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      const payload = await res.json().catch(() => ({}))

      // A token is emailed once per order, and only while the order is
      // approved. Either refusal means this panel is out of date, so it stops
      // offering the send and lets the surface refresh instead of failing.
      const refusal = readTokenSendRefusal(res.status, payload)
      if (refusal) {
        setSent(true)
        toast({
          title: refusal.kind === "already-sent" ? TOKEN_SENT_LABEL : "Order already updated",
          description: `${label} — ${refusal.message}`,
        })
        if (refusal.kind === "not-approved") onFulfilled?.()
        return
      }

      if (!res.ok) {
        toast({
          title: "Token email not sent",
          description: payload?.error || "Please try again.",
          variant: "destructive",
        })
        return
      }

      setSent(true)
      toast({
        title: payload?.fulfilled ? "Token sent — order fulfilled" : "Token sent to admin",
        description: `${label} — ${handoffOutcome(payload)}`,
      })
      if (payload?.fulfilled) onFulfilled?.()
    } catch {
      toast({
        title: "Token email not sent",
        description: "Check your connection and try again.",
        variant: "destructive",
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900/60 dark:bg-emerald-950/20 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-2">
        <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
            Fulfilment token{branchName ? ` · ${branchName}` : ""}
          </p>
          <p className="truncate font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
            {token}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1 rounded-lg"
          onClick={copyToken}
          aria-label={`Copy fulfilment token for ${label}`}
        >
          <Copy className="h-3.5 w-3.5" />
          Copy
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1 rounded-lg"
          onClick={sendToken}
          disabled={sending || sent}
          aria-label={`Email fulfilment token for ${label} to admin operations`}
        >
          <Mail className="h-3.5 w-3.5" />
          {(() => {
            if (sending) return "Sending…"
            return sent ? "Sent to admin" : "Email to admin"
          })()}
        </Button>
      </div>
    </div>
  )
}
