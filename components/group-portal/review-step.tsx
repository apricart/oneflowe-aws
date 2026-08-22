"use client"

import { ArrowLeft, Building2, Info, Loader2, Send } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { formatPKR } from "@/lib/utils"

import { formatLineQuantity } from "./order-summary-panel"
import type { BranchPlan } from "./types"

/**
 * Step 4 — the full preview before anything is created.
 *
 * This is where the user sees the one thing the wizard has been hiding: the
 * submission becomes one order per branch. Saying so plainly here, next to the
 * per-branch breakdown they are about to approve, is what keeps "one group
 * order" from being a surprise when the orders show up individually.
 */
export function ReviewStep({
  groupName,
  branchPlans,
  notes,
  submitting,
  onNotesChange,
  onBack,
  onSubmit,
}: Readonly<{
  groupName: string
  branchPlans: BranchPlan[]
  notes: string
  submitting: boolean
  onNotesChange: (notes: string) => void
  onBack: () => void
  onSubmit: () => void
}>) {
  const grandTotalCents = branchPlans.reduce((sum, plan) => sum + plan.totalCents, 0)
  const totalLines = branchPlans.reduce((sum, plan) => sum + plan.lines.length, 0)

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Review your group order
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{groupName}</p>
        </div>
        <Button type="button" variant="outline" size="sm" className="w-fit gap-2" onClick={onBack} disabled={submitting}>
          <ArrowLeft className="h-4 w-4" />
          Keep adding
        </Button>
      </div>

      <Card className="rounded-xl border-sky-200 bg-sky-50/60 dark:border-sky-900/60 dark:bg-sky-950/20">
        <CardContent className="flex items-start gap-2 p-3 text-xs text-slate-700 dark:text-slate-300">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" />
          <span>
            This is submitted as one group order and tracked under a single reference. Each branch
            below is raised and approved as its own order, against that branch&apos;s own budget — so{" "}
            <span className="font-medium">
              {branchPlans.length} order{branchPlans.length === 1 ? "" : "s"}
            </span>{" "}
            will be created. If one branch cannot be ordered for, the rest still go through and you
            will see exactly which failed and why.
          </span>
        </CardContent>
      </Card>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ReviewStat label="Group" value={groupName} />
        <ReviewStat label="Branches" value={String(branchPlans.length)} />
        <ReviewStat label="Line items" value={String(totalLines)} />
        <ReviewStat label="Combined total" value={formatPKR(grandTotalCents / 100)} />
      </dl>

      <div className="space-y-3">
        {branchPlans.map((plan) => (
          <Card key={plan.branch.id} className="rounded-2xl">
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-slate-400" />
                  {plan.branch.name}
                  {plan.branch.city && (
                    <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                      {plan.branch.city}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <Badge variant="secondary">{plan.lines.length} items</Badge>
                  <span className="font-mono text-sm">{formatPKR(plan.totalCents / 100)}</span>
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      <th scope="col" className="pb-2 font-medium">Product</th>
                      <th scope="col" className="pb-2 text-right font-medium">Quantity</th>
                      <th scope="col" className="pb-2 text-right font-medium">Unit price</th>
                      <th scope="col" className="pb-2 text-right font-medium">Line total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.lines.map((line) => (
                      <tr key={line.organizationInventoryId} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                        <td className="py-2 pr-3 text-slate-800 dark:text-slate-200">{line.name}</td>
                        <td className="py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
                          {formatLineQuantity(line.quantity, line.unit)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
                          {formatPKR(line.priceCents / 100)}
                        </td>
                        <td className="py-2 text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">
                          {formatPKR((line.priceCents * line.quantity) / 100)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="space-y-2">
        <label htmlFor="group-order-notes" className="text-sm font-medium text-slate-700 dark:text-slate-200">
          Notes (optional)
        </label>
        <Textarea
          id="group-order-notes"
          value={notes}
          onChange={(event) => onNotesChange(event.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="Anything the approver should know. Added to every branch order in this group."
          disabled={submitting}
        />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button type="button" className="gap-2" onClick={onSubmit} disabled={submitting || branchPlans.length === 0}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {submitting ? "Submitting…" : `Submit group order (${branchPlans.length})`}
        </Button>
      </div>
    </div>
  )
}

function ReviewStat({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      <dt className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold text-slate-900 dark:text-slate-100" title={value}>
        {value}
      </dd>
    </div>
  )
}
