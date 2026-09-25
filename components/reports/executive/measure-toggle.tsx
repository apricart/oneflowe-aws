"use client"

import * as React from "react"
import { Coins, Package2 } from "lucide-react"

import { MEASURE_LABEL, type MeasureId } from "@/lib/executive-analytics"
import { cn } from "@/lib/utils"

/**
 * Amount ⇄ Quantity, as one control.
 *
 * The two answer different questions about the same purchases — a branch whose
 * spend rose a fifth while its quantity fell reads as efficient on one and
 * wasteful on the other, and neither number says that alone. Flipping between
 * them is therefore the most-used action on these screens, which is why it is a
 * single two-state control rather than two entries buried in a row of seven
 * metrics.
 *
 * Switching changes the measure and nothing else. Every filter, the focused
 * products, the entities being compared and any open detail table are carried
 * across untouched, because losing them would make the comparison the reader
 * had just built have to be rebuilt to ask half of the question.
 */
export function MeasureToggle({ value, onChange, className }: Readonly<{
  value: MeasureId
  onChange: (next: MeasureId) => void
  className?: string
}>) {
  const options: Array<{ id: MeasureId; icon: typeof Coins }> = [
    { id: "amount", icon: Coins },
    { id: "quantity", icon: Package2 },
  ]

  return (
    <div
      role="group"
      aria-label="Measure"
      className={cn(
        "flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1 dark:border-slate-700 dark:bg-slate-800/60",
        className,
      )}
    >
      {options.map((option) => {
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={value === option.id}
            title={`Measure by ${MEASURE_LABEL[option.id].toLowerCase()}`}
            onClick={() => onChange(option.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
              value === option.id
                ? "bg-white text-indigo-600 shadow-sm ring-1 ring-slate-200 dark:bg-slate-700 dark:text-indigo-300 dark:ring-slate-600"
                : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200",
            )}
          >
            <option.icon className="h-3.5 w-3.5" aria-hidden />
            {MEASURE_LABEL[option.id]}
          </button>
        )
      })}
    </div>
  )
}
