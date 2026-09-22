"use client"

import { useState } from "react"
import { AlertTriangle, Ban, ChevronDown, ChevronUp, ShieldCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { PaymentControlView } from "@/lib/payment-control-view"
import { formatDateTime } from "@/lib/utils"

import { PaymentControlTimeline } from "./payment-control-timeline"

export type PaymentControlNotice = {
  tone: "warning" | "blocked" | "exception"
  title: string
  body: string
  note: string | null
}

const plural = (count: number, noun: string) => `${count} overdue ${noun}${count === 1 ? "" : "s"}`

/**
 * What an ordering user is told, in plain words, for each state. Pure so the
 * wording is testable on its own. `null` means there is nothing to show:
 * the branch is clear, or no payment source is connected.
 */
export function paymentControlNotice(view: PaymentControlView | null | undefined): PaymentControlNotice | null {
  if (!view || !view.configured) return null
  if (view.state === "CLEAR") return null

  if (view.state === "WARNING") {
    return {
      tone: "warning",
      title: `Your branch has ${plural(view.overdueCount, "payment")}.`,
      body: `Ordering is still available. New orders stop if ${view.threshold} payments become overdue.`,
      note: null,
    }
  }

  if (view.exceptionActive && view.exception) {
    return {
      tone: "exception",
      title: "Head Office has temporarily allowed ordering despite overdue payments.",
      body: `This exception ends on ${formatDateTime(view.exception.expiresAt)}. ${plural(view.overdueCount, "payment")} still need${view.overdueCount === 1 ? "s" : ""} to be cleared; when the exception ends, ordering stops again unless they have been.`,
      note: null,
    }
  }

  const ended = view.exception?.revokedAt
    ? `The Head Office exception was ended on ${formatDateTime(view.exception.revokedAt)}.`
    : view.exception && view.reason === "EXCEPTION_EXPIRED"
      ? `The Head Office exception ended on ${formatDateTime(view.exception.expiresAt)}.`
      : null

  return {
    tone: "blocked",
    title: "Ordering is temporarily unavailable because the overdue payment limit has been reached.",
    body: `${plural(view.overdueCount, "payment")}; the limit is ${view.threshold}. New orders can be placed again once the overdue payments are cleared. Please contact your Head Office.`,
    note: ended,
  }
}

const TONE_STYLES: Record<PaymentControlNotice["tone"], { wrapper: string; title: string; body: string; icon: typeof AlertTriangle }> = {
  warning: {
    wrapper: "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30",
    title: "text-amber-900 dark:text-amber-100",
    body: "text-amber-800 dark:text-amber-200",
    icon: AlertTriangle,
  },
  blocked: {
    wrapper: "border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/30",
    title: "text-rose-900 dark:text-rose-100",
    body: "text-rose-800 dark:text-rose-200",
    icon: Ban,
  },
  exception: {
    wrapper: "border-indigo-200 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950/30",
    title: "text-indigo-900 dark:text-indigo-100",
    body: "text-indigo-800 dark:text-indigo-200",
    icon: ShieldCheck,
  },
}

/**
 * The notice an ordering user sees above the store. Nothing is rendered for
 * a clear branch or while no payment source is connected.
 */
export function PaymentControlBanner({ view, className = "" }: { view: PaymentControlView | null | undefined; className?: string }) {
  const [expanded, setExpanded] = useState(false)
  const notice = paymentControlNotice(view)
  if (!notice || !view) return null

  const style = TONE_STYLES[notice.tone]
  const Icon = style.icon
  const detailsId = `payment-control-details-${view.branch.id}`

  return (
    <section
      role={notice.tone === "blocked" ? "alert" : "status"}
      aria-live="polite"
      data-testid="payment-control-banner"
      data-tone={notice.tone}
      className={`rounded-2xl border p-4 ${style.wrapper} ${className}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${style.title}`} aria-hidden="true" />
          <div className="space-y-1">
            <p className={`font-semibold ${style.title}`}>{notice.title}</p>
            <p className={`text-sm ${style.body}`}>{notice.body}</p>
            {notice.note && <p className={`text-xs ${style.body}`}>{notice.note}</p>}
            <p className={`text-xs ${style.body}`}>
              Status: <span className="font-medium">{view.orderingAllowed ? "ordering allowed" : "ordering stopped"}</span>
              {" · "}
              {view.overdueCount} of {view.threshold} overdue
              {view.limitReached ? " · limit reached" : ""}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 gap-1"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          {expanded ? "Hide details" : "What happens next"}
        </Button>
      </div>

      {expanded && (
        <div id={detailsId} className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <p className={`mb-2 text-xs font-semibold uppercase tracking-wider ${style.body}`}>Timeline</p>
            <PaymentControlTimeline steps={view.timeline} />
          </div>
          {view.overdueItems.length > 0 && (
            <div>
              <p className={`mb-2 text-xs font-semibold uppercase tracking-wider ${style.body}`}>Overdue payments</p>
              <ul className="space-y-2">
                {view.overdueItems.map((item) => (
                  <li key={item.reference} className="flex items-center justify-between gap-3 rounded-xl border bg-white p-3 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-800">
                    <span className="font-medium dark:text-white">{item.reference}</span>
                    <span className="text-xs text-muted-foreground">
                      {item.overdueSince ? `overdue since ${formatDateTime(item.overdueSince)}` : "date not recorded"}
                      {item.amountCents !== null ? ` · PKR ${(item.amountCents / 100).toFixed(2)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
