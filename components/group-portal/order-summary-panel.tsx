"use client"

import { Building2, ClipboardList, Package, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatQuantity } from "@/lib/quantity"
import { formatPKR } from "@/lib/utils"

import { entryTotalCents } from "./group-order-plan"
import type { BranchPlan, GroupOrderEntry, ScopedBranch } from "./types"

/**
 * The running group order, updated as each entry is saved.
 *
 * It answers the two questions the user has while building: what have I added
 * so far, and what will each branch actually receive. The per-branch view is
 * the merged one, because that — not the entry list — is what becomes orders.
 */
export function OrderSummaryPanel({
  entries,
  branchPlans,
  branchesById,
  onRemoveEntry,
  onReview,
}: Readonly<{
  entries: GroupOrderEntry[]
  branchPlans: BranchPlan[]
  branchesById: Map<number, ScopedBranch>
  onRemoveEntry: (key: string) => void
  onReview: () => void
}>) {
  const grandTotalCents = branchPlans.reduce((sum, plan) => sum + plan.totalCents, 0)

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardList className="h-4 w-4" />
          Group order so far
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {entries.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Nothing added yet. Pick locations, then items, then save the step — repeat as many times
            as you need.
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-3 gap-2 text-center">
              <SummaryStat label="Steps" value={String(entries.length)} />
              <SummaryStat label="Branches" value={String(branchPlans.length)} />
              <SummaryStat label="Orders" value={String(branchPlans.length)} />
            </dl>

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Saved steps
              </p>
              <ul className="space-y-2">
                {entries.map((entry, index) => (
                  <li
                    key={entry.key}
                    className="rounded-xl border border-slate-200 p-2.5 dark:border-slate-800"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                          Step {index + 1}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                          {entry.branchIds
                            .map((branchId) => branchesById.get(branchId)?.name ?? `Branch ${branchId}`)
                            .join(", ")}
                        </p>
                        <p className="mt-1 flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                          <span className="flex items-center gap-1">
                            <Building2 className="h-3 w-3" />
                            {entry.branchIds.length}
                          </span>
                          <span className="flex items-center gap-1">
                            <Package className="h-3 w-3" />
                            {entry.lines.length}
                          </span>
                          <span>{formatPKR(entryTotalCents(entry.lines) / 100)} each</span>
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-slate-400 hover:text-rose-600"
                        aria-label={`Remove step ${index + 1}`}
                        onClick={() => onRemoveEntry(entry.key)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Per branch
              </p>
              <ul className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                {branchPlans.map((plan) => (
                  <li
                    key={plan.branch.id}
                    className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs dark:bg-slate-800/60"
                  >
                    <span className="min-w-0 truncate text-slate-700 dark:text-slate-200">
                      {plan.branch.name}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-slate-500 dark:text-slate-400">
                      <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                        {plan.lines.length} item{plan.lines.length === 1 ? "" : "s"}
                      </Badge>
                      {formatPKR(plan.totalCents / 100)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 pt-3 text-sm dark:border-slate-800">
              <span className="font-medium text-slate-700 dark:text-slate-200">Combined total</span>
              <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                {formatPKR(grandTotalCents / 100)}
              </span>
            </div>

            <Button type="button" className="w-full" onClick={onReview}>
              Review and submit
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function SummaryStat({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="rounded-xl bg-slate-50 p-2 dark:bg-slate-800/60">
      <dt className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="text-lg font-semibold text-slate-900 dark:text-slate-100">{value}</dd>
    </div>
  )
}

/** Shared by the summary panel and the review step so quantities render alike. */
export function formatLineQuantity(quantity: number, unit: string): string {
  return `${formatQuantity(quantity)} ${unit}`
}
