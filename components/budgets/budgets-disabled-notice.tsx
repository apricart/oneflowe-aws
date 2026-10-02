import { Wallet } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * What a budget page shows for an organization whose budget allocation is
 * switched off — in words, rather than a page of zeroes that would read as a
 * budget of nothing.
 */
export function BudgetsDisabledNotice({ className }: Readonly<{ className?: string }>) {
  return (
    <div
      role="status"
      className={cn(
        "mx-auto flex max-w-xl flex-col items-center gap-3 rounded-2xl border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900",
        className,
      )}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        <Wallet className="h-6 w-6" aria-hidden />
      </span>
      <p className="text-base font-semibold text-slate-900 dark:text-white">
        Budget allocation is off for this organization
      </p>
      <p className="text-sm text-muted-foreground">
        Orders are placed without a budget, so there is nothing to allocate or report here. A Super Admin can
        switch budget allocation on from Edit Company.
      </p>
    </div>
  )
}
