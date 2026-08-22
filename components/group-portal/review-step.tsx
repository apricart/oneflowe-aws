"use client"

import { useMemo } from "react"
import { ArrowLeft, Building2, Info, Loader2, Pencil, Send, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { MAX_PO_NUMBER_LENGTH, PO_NUMBER_HINT, normalizePoNumberInput } from "@/lib/purchase-order"
import { calculateLineCents, sanitizeQuantityStep } from "@/lib/quantity"
import { formatPKR } from "@/lib/utils"

import { QuantityStepper } from "./quantity-stepper"
import type { BranchPlan, SelectedLine } from "./types"

/**
 * Step 4 — the full preview, and the last place anything can be corrected.
 *
 * This is where the user sees the one thing the wizard has been hiding: the
 * submission becomes one order per branch. Saying so plainly here, next to the
 * per-branch breakdown they are about to approve, is what keeps "one group
 * order" from being a surprise when the orders show up individually.
 *
 * Quantities are editable in place because this is the first screen that shows
 * a branch its own final numbers. A change applies to that branch alone unless
 * the user asks for it everywhere, since the whole point of reviewing per branch
 * is to be able to treat one branch differently from the rest.
 */
export function ReviewStep({
  groupName,
  branchPlans,
  notes,
  poNumber,
  submitting,
  onNotesChange,
  onPoNumberChange,
  onQuantityChange,
  onApplyQuantityToAll,
  onRemoveBranch,
  onBack,
  onSubmit,
}: Readonly<{
  groupName: string
  branchPlans: BranchPlan[]
  notes: string
  poNumber: string
  submitting: boolean
  onNotesChange: (notes: string) => void
  onPoNumberChange: (poNumber: string) => void
  onQuantityChange: (organizationInventoryId: number, quantity: number, branchId: number) => void
  onApplyQuantityToAll: (organizationInventoryId: number, sourceBranchId: number) => void
  onRemoveBranch: (branchId: number) => void
  onBack: () => void
  onSubmit: () => void
}>) {
  const grandTotalCents = branchPlans.reduce((sum, plan) => sum + plan.totalCents, 0)
  const totalLines = branchPlans.reduce((sum, plan) => sum + plan.lines.length, 0)

  /** How many branches receive each product, so "apply to all" can say how many. */
  const branchesPerProduct = useMemo(() => {
    const counts = new Map<number, number>()
    for (const plan of branchPlans) {
      for (const line of plan.lines) {
        counts.set(line.organizationInventoryId, (counts.get(line.organizationInventoryId) ?? 0) + 1)
      }
    }
    return counts
  }, [branchPlans])

  if (branchPlans.length === 0) {
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Review your group order
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{groupName}</p>
        </div>
        <Card className="rounded-2xl border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20">
          <CardContent className="space-y-3 p-5 text-sm text-slate-700 dark:text-slate-300">
            <p>There is nothing left in this group order — every line has been removed.</p>
            <Button type="button" size="sm" className="gap-2" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />
              Back to locations
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

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

      <Card className="rounded-xl border-slate-200 dark:border-slate-800">
        <CardContent className="flex items-start gap-2 p-3 text-xs text-slate-600 dark:text-slate-300">
          <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
          <span>
            Quantities can still be changed here. An edit applies to that location only — use{" "}
            <span className="font-medium">Apply to all</span> to give every location the same
            quantity. Setting a quantity to zero removes that line.
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-slate-400 hover:text-rose-600"
                    aria-label={`Remove ${plan.branch.name} from this group order`}
                    title="Remove this location from the group order"
                    disabled={submitting}
                    onClick={() => onRemoveBranch(plan.branch.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      <th scope="col" className="pb-2 font-medium">Product</th>
                      <th scope="col" className="pb-2 text-right font-medium">Quantity</th>
                      <th scope="col" className="pb-2 text-right font-medium">Unit price</th>
                      <th scope="col" className="pb-2 text-right font-medium">Line total</th>
                      <th scope="col" className="pb-2 text-right font-medium">
                        <span className="sr-only">Remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.lines.map((line) => (
                      <ReviewLineRow
                        key={line.organizationInventoryId}
                        line={line}
                        branchName={plan.branch.name}
                        sharedBranchCount={branchesPerProduct.get(line.organizationInventoryId) ?? 1}
                        disabled={submitting}
                        onQuantityChange={(quantity) =>
                          onQuantityChange(line.organizationInventoryId, quantity, plan.branch.id)}
                        onApplyToAll={() =>
                          onApplyQuantityToAll(line.organizationInventoryId, plan.branch.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="space-y-2">
        <label htmlFor="group-order-po-number" className="text-sm font-medium text-slate-700 dark:text-slate-200">
          Purchase order number (optional)
        </label>
        <Input
          id="group-order-po-number"
          value={poNumber}
          onChange={(event) => onPoNumberChange(normalizePoNumberInput(event.target.value))}
          maxLength={MAX_PO_NUMBER_LENGTH}
          placeholder="e.g. PO-2026-0148"
          autoComplete="off"
          disabled={submitting}
        />
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Your own reference. Printed as P.O.# on the invoice for every location in this group order.
          {" "}{PO_NUMBER_HINT}.
        </p>
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

/**
 * One editable line of one branch's order.
 *
 * The step comes from the product's own rules, carried on the line, so a
 * whole-number product cannot be stepped into a fraction the server would
 * refuse for that branch.
 */
function ReviewLineRow({
  line,
  branchName,
  sharedBranchCount,
  disabled,
  onQuantityChange,
  onApplyToAll,
}: Readonly<{
  line: SelectedLine
  branchName: string
  sharedBranchCount: number
  disabled: boolean
  onQuantityChange: (quantity: number) => void
  onApplyToAll: () => void
}>) {
  const step = sanitizeQuantityStep(Boolean(line.allowDecimalQuantity), line.quantityStep ?? 1)

  return (
    <tr className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
      <td className="py-2 pr-3 text-slate-800 dark:text-slate-200">{line.name}</td>
      <td className="py-2">
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <QuantityStepper
              value={line.quantity}
              step={step}
              label={`Quantity of ${line.name} for ${branchName}`}
              disabled={disabled}
              onChange={onQuantityChange}
            />
            <span className="text-xs text-slate-500 dark:text-slate-400">{line.unit}</span>
          </div>
          {sharedBranchCount > 1 && (
            <button
              type="button"
              disabled={disabled}
              onClick={onApplyToAll}
              className="text-[10px] font-medium text-indigo-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-indigo-400"
            >
              Apply to all {sharedBranchCount} locations
            </button>
          )}
        </div>
      </td>
      <td className="py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
        {formatPKR(line.priceCents / 100)}
      </td>
      <td className="py-2 text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">
        {/* Rounded the way the branch total above and the server below both
            round it, so the line rows add up to the figure they sit under. */}
        {formatPKR(calculateLineCents(line.priceCents, line.quantity) / 100)}
      </td>
      <td className="py-2 pl-2 text-right">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-slate-400 hover:text-rose-600"
          aria-label={`Remove ${line.name} from ${branchName}`}
          disabled={disabled}
          onClick={() => onQuantityChange(0)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </td>
    </tr>
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
