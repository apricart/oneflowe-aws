"use client"

import { CheckCircle, Clock } from "lucide-react"

import type { PaymentControlTimelineStepView } from "@/lib/payment-control-view"
import { formatDateTime } from "@/lib/utils"

/**
 * The consequence timeline, in the same stepper the order page uses for an
 * order's status: a circle per step (green done, indigo now, grey next),
 * joined by a vertical bar. A step with no date is shown undated — the data
 * behind it does not carry one, and none is invented.
 */
export function PaymentControlTimeline({ steps }: { steps: PaymentControlTimelineStepView[] }) {
  if (steps.length === 0) return null

  return (
    <ol className="space-y-3" aria-label="Payment status timeline">
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1
        const isComplete = step.state === "complete"
        const isCurrent = step.state === "current"
        const circle = isComplete
          ? "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300"
          : isCurrent
            ? "border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300"
            : "border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-400 dark:text-slate-400"

        return (
          <li key={step.key} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${circle}`} aria-hidden="true">
                {isComplete && <CheckCircle className="h-4 w-4" />}
                {isCurrent && <Clock className="h-4 w-4" />}
              </div>
              {!isLast && (
                <div className={`mt-1 w-px flex-1 ${isComplete ? "bg-emerald-100 dark:bg-emerald-900" : "bg-slate-200 dark:bg-slate-600"}`} />
              )}
            </div>
            <div className={`flex-1 rounded-xl border bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-800 ${step.state === "upcoming" ? "opacity-75" : ""}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-sm font-semibold dark:text-white">
                  {step.label}
                  {isCurrent && <span className="ml-2 text-[10px] font-normal uppercase tracking-wider text-indigo-600 dark:text-indigo-300">Now</span>}
                  {step.state === "upcoming" && <span className="ml-2 text-[10px] font-normal uppercase tracking-wider text-muted-foreground">Next</span>}
                </p>
                {step.at && <time dateTime={step.at} className="text-xs text-muted-foreground">{formatDateTime(step.at)}</time>}
              </div>
              <p className="text-xs text-muted-foreground">{step.description}</p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
