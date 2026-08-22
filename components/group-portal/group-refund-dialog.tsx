"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Building2,
  CheckCircle2,
  Info,
  Layers,
  Package,
  RotateCcw,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ListSkeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import { formatQuantity, parseQuantity } from "@/lib/quantity"
import { cn, formatPKR } from "@/lib/utils"

import {
  type ProductGroup,
  type RefundSelection,
  applyProductToAllBranches,
  buildProductGroups,
  clampToRemaining,
  clearOrder,
  clearProductEverywhere,
  linesFor,
  orderSubtotalCents,
  quantityFor,
  setLineQuantity,
  stepForLine,
  summarizeSelection,
  toRequestPayload,
} from "./group-refund-plan"
import type {
  GroupRefundSubmission,
  GroupRefundWorkspace,
  RefundableLine,
  RefundableOrder,
} from "./types"

const MAX_REASON_LENGTH = 255

/** Reasons this team raises again and again, offered as one tap instead of typing. */
const QUICK_REASONS = [
  "Damaged on delivery",
  "Short delivered",
  "Wrong item delivered",
  "Quality not acceptable",
  "Expired stock",
] as const

type Step = "items" | "reason" | "review" | "done"
type Mode = "product" | "branch"

/**
 * Request a refund against one group order.
 *
 * The single-order refund form asks "which lines of this order", which is the
 * wrong first question here: a group order is the same basket at many branches,
 * so the complaint is usually "this product, at every branch that got it". The
 * default view is therefore by product across branches, with a per-branch view
 * a click away for the times the problem really is local to one shop.
 *
 * The server is the authority throughout. What is refundable, how much is left
 * on each line, and which branches are eligible at all are read from
 * `/api/v1/group-portal/refunds/[groupOrderId]` and re-derived again when the
 * request is submitted, so nothing decided on this screen can outrank it.
 */
export function GroupRefundDialog({
  groupOrderId,
  reference,
  open,
  onClose,
  onSubmitted,
}: Readonly<{
  groupOrderId: number | null
  reference: string
  open: boolean
  onClose: () => void
  onSubmitted?: () => void
}>) {
  const { toast } = useToast()
  const [step, setStep] = useState<Step>("items")
  const [mode, setMode] = useState<Mode>("product")
  const [selection, setSelection] = useState<RefundSelection>({})
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [submission, setSubmission] = useState<GroupRefundSubmission | null>(null)

  const { data, error, isLoading, mutate } = useSWR<{ item: GroupRefundWorkspace }>(
    open && groupOrderId ? `/api/v1/group-portal/refunds/${groupOrderId}` : null,
    fetcher,
    { revalidateOnFocus: false },
  )

  const workspace = data?.item
  const refundable = useMemo(() => workspace?.refundable ?? [], [workspace])
  const productGroups = useMemo(() => buildProductGroups(refundable), [refundable])
  const totals = useMemo(() => summarizeSelection(selection, refundable), [selection, refundable])

  const reset = () => {
    setStep("items")
    setMode("product")
    setSelection({})
    setReason("")
    setSubmission(null)
  }

  const handleClose = () => {
    onClose()
    // Leave the sheet's closing animation alone before clearing what it shows.
    setTimeout(reset, 200)
  }

  const submit = async () => {
    if (!groupOrderId) return
    setSubmitting(true)
    try {
      const res = await fetch("/api/v1/group-portal/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupOrderId,
          orders: toRequestPayload(selection),
          reason: reason.trim(),
        }),
      })
      const payload = await res.json().catch(() => ({}))

      if (!res.ok) {
        toast({
          title: "Refund request not submitted",
          description: payload?.error || "Please review your selection and try again.",
          variant: "destructive",
        })
        return
      }

      setSubmission(payload.item as GroupRefundSubmission)
      setStep("done")
      onSubmitted?.()
      void mutate()
    } catch {
      toast({
        title: "Refund request not submitted",
        description: "Check your connection and try again.",
        variant: "destructive",
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={(next) => !next && handleClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl"
      >
        <SheetHeader className="border-b border-slate-200 px-6 py-4 dark:border-slate-800">
          <SheetTitle className="flex items-center gap-2 text-base">
            <RotateCcw className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            Request a refund
          </SheetTitle>
          <SheetDescription>
            Group order <span className="font-mono font-semibold">{reference}</span>
            {workspace?.groupOrder.groupName ? ` · ${workspace.groupOrder.groupName}` : ""}
          </SheetDescription>
          {step !== "done" && <StepTrail step={step} />}
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {(() => {
            if (isLoading) return <ListSkeleton rows={5} />
            if (error || !workspace) return <WorkspaceError />
            if (step === "done" && submission) {
              return <RefundResult submission={submission} />
            }
            if (step === "reason") {
              return <ReasonStep reason={reason} onChange={setReason} />
            }
            if (step === "review") {
              return <ReviewStep selection={selection} orders={refundable} reason={reason} />
            }
            return (
              <ItemsStep
                mode={mode}
                onModeChange={setMode}
                workspace={workspace}
                productGroups={productGroups}
                selection={selection}
                onSelectionChange={setSelection}
              />
            )
          })()}
        </div>

        <SheetFooterBar
          step={step}
          totals={totals}
          reason={reason}
          submitting={submitting}
          disabled={isLoading || Boolean(error) || !workspace}
          onBack={() => setStep(step === "review" ? "reason" : "items")}
          onNext={() => setStep(step === "items" ? "reason" : "review")}
          onSubmit={submit}
          onClose={handleClose}
        />
      </SheetContent>
    </Sheet>
  )
}

function WorkspaceError() {
  return (
    <div
      role="alert"
      className="rounded-xl border border-rose-200 bg-rose-50/60 p-4 text-sm text-slate-700 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-slate-300"
    >
      This group order&apos;s refund details could not be loaded. Please close this panel and try
      again.
    </div>
  )
}

const STEP_LABELS: Array<{ id: Step; label: string }> = [
  { id: "items", label: "Items" },
  { id: "reason", label: "Reason" },
  { id: "review", label: "Review" },
]

function StepTrail({ step }: Readonly<{ step: Step }>) {
  const activeIndex = STEP_LABELS.findIndex((entry) => entry.id === step)

  return (
    <ol className="mt-3 flex items-center gap-2 text-xs">
      {STEP_LABELS.map((entry, index) => (
        <li key={entry.id} className="flex items-center gap-2">
          <span
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold",
              index <= activeIndex
                ? "bg-indigo-600 text-white"
                : "bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
            )}
          >
            {index + 1}
          </span>
          <span
            className={cn(
              "font-medium",
              index === activeIndex
                ? "text-slate-900 dark:text-slate-100"
                : "text-slate-500 dark:text-slate-400",
            )}
          >
            {entry.label}
          </span>
          {index < STEP_LABELS.length - 1 && (
            <span className="h-px w-4 bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
          )}
        </li>
      ))}
    </ol>
  )
}

function SheetFooterBar({
  step,
  totals,
  reason,
  submitting,
  disabled,
  onBack,
  onNext,
  onSubmit,
  onClose,
}: Readonly<{
  step: Step
  totals: ReturnType<typeof summarizeSelection>
  reason: string
  submitting: boolean
  disabled: boolean
  onBack: () => void
  onNext: () => void
  onSubmit: () => void
  onClose: () => void
}>) {
  if (step === "done") {
    return (
      <div className="border-t border-slate-200 px-6 py-4 dark:border-slate-800">
        <Button type="button" className="w-full" onClick={onClose}>
          Done
        </Button>
      </div>
    )
  }

  const hasSelection = totals.lineCount > 0
  const reasonReady = reason.trim().length > 0

  return (
    <div className="flex flex-col gap-3 border-t border-slate-200 px-6 py-4 dark:border-slate-800 sm:flex-row sm:items-center sm:justify-between">
      <output className="text-xs text-slate-600 dark:text-slate-300">
        {hasSelection ? (
          <>
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {formatPKR(totals.totalCents / 100)}
            </span>{" "}
            · {totals.branchCount} branch{totals.branchCount === 1 ? "" : "es"} · {totals.lineCount}{" "}
            line{totals.lineCount === 1 ? "" : "s"} · {formatQuantity(totals.totalQuantity)} units
          </>
        ) : (
          "Nothing selected yet"
        )}
      </output>
      <div className="flex items-center gap-2">
        {step !== "items" && (
          <Button type="button" variant="outline" size="sm" className="gap-1" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
        )}
        {step === "review" ? (
          <Button
            type="button"
            size="sm"
            disabled={submitting || disabled || !hasSelection || !reasonReady}
            onClick={onSubmit}
          >
            {submitting ? "Submitting…" : "Submit refund request"}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={disabled || !hasSelection || (step === "reason" && !reasonReady)}
            onClick={onNext}
          >
            Continue
          </Button>
        )}
      </div>
    </div>
  )
}

function ItemsStep({
  mode,
  onModeChange,
  workspace,
  productGroups,
  selection,
  onSelectionChange,
}: Readonly<{
  mode: Mode
  onModeChange: (mode: Mode) => void
  workspace: GroupRefundWorkspace
  productGroups: ProductGroup[]
  selection: RefundSelection
  onSelectionChange: (selection: RefundSelection) => void
}>) {
  const { refundable, ineligible } = workspace

  if (refundable.length === 0) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-center text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          <Ban className="mx-auto mb-2 h-6 w-6 text-slate-400" />
          No branch order in this group order can be refunded right now.
        </div>
        <IneligibleList orders={ineligible} />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {refundable.length} branch order{refundable.length === 1 ? "" : "s"} can be refunded.
        </p>
        <div
          role="radiogroup"
          aria-label="How to choose what to refund"
          className="inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-800"
        >
          <ModeButton
            active={mode === "product"}
            onClick={() => onModeChange("product")}
            icon={<Package className="h-3.5 w-3.5" />}
            label="By product"
          />
          <ModeButton
            active={mode === "branch"}
            onClick={() => onModeChange("branch")}
            icon={<Building2 className="h-3.5 w-3.5" />}
            label="By branch"
          />
        </div>
      </div>

      {mode === "product" ? (
        <div className="space-y-3">
          <p className="flex items-start gap-2 rounded-lg bg-indigo-50/70 p-3 text-xs text-slate-600 dark:bg-indigo-950/20 dark:text-slate-300">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" />
            Enter a quantity once to refund it at every branch that received the product. Branches
            with less left are capped at what they have, and are named when that happens.
          </p>
          {productGroups.map((group) => (
            <ProductRow
              key={group.globalProductId}
              group={group}
              selection={selection}
              onSelectionChange={onSelectionChange}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {refundable.map((order) => (
            <BranchOrderRow
              key={order.orderId}
              order={order}
              selection={selection}
              onSelectionChange={onSelectionChange}
            />
          ))}
        </div>
      )}

      <IneligibleList orders={ineligible} />
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: Readonly<{ active: boolean; onClick: () => void; icon: React.ReactNode; label: string }>) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition",
        active
          ? "bg-indigo-600 text-white"
          : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function ProductRow({
  group,
  selection,
  onSelectionChange,
}: Readonly<{
  group: ProductGroup
  selection: RefundSelection
  onSelectionChange: (selection: RefundSelection) => void
}>) {
  const [expanded, setExpanded] = useState(false)
  const [capped, setCapped] = useState<string[]>([])

  const selectedBranches = group.occurrences.filter(
    (occurrence) => quantityFor(selection, occurrence.orderId, occurrence.line.orderItemId) > 0,
  )
  const selectedQuantity = selectedBranches.reduce(
    (sum, occurrence) => sum + quantityFor(selection, occurrence.orderId, occurrence.line.orderItemId),
    0,
  )

  const applyToAll = (raw: string) => {
    const quantity = parseQuantity(raw)
    if (quantity <= 0) {
      setCapped([])
      onSelectionChange(clearProductEverywhere(selection, group))
      return
    }
    const result = applyProductToAllBranches(selection, group, quantity)
    setCapped(result.cappedBranchNames)
    onSelectionChange(result.selection)
  }

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800">
      <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {group.productName}
          </p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {group.productCode ? `${group.productCode} · ` : ""}
            {formatPKR(group.priceCents / 100)} per {group.unit || "unit"} ·{" "}
            {group.occurrences.length} branch{group.occurrences.length === 1 ? "" : "es"} ·{" "}
            {formatQuantity(group.smallestRemaining)}–{formatQuantity(group.largestRemaining)} left
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Label htmlFor={`apply-all-${group.globalProductId}`} className="text-xs text-slate-500">
            Qty per branch
          </Label>
          <Input
            id={`apply-all-${group.globalProductId}`}
            type="number"
            inputMode="decimal"
            min={0}
            max={group.largestRemaining}
            className="h-8 w-24"
            onChange={(event) => applyToAll(event.target.value)}
          />
        </div>
      </div>

      {selectedBranches.length > 0 && (
        <p className="px-3 pb-2 text-xs text-emerald-700 dark:text-emerald-400">
          {formatQuantity(selectedQuantity)} {group.unit || "units"} selected across{" "}
          {selectedBranches.length} branch{selectedBranches.length === 1 ? "" : "es"}
        </p>
      )}

      {capped.length > 0 && (
        <p className="flex items-start gap-1.5 px-3 pb-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          Capped at what was left for: {capped.join(", ")}
        </p>
      )}

      <div className="border-t border-slate-100 px-3 py-2 dark:border-slate-800/70">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          {expanded ? "Hide branches" : "Adjust individual branches"}
        </button>

        {expanded && (
          <ul className="mt-2 space-y-2">
            {group.occurrences.map((occurrence) => (
              <li
                key={occurrence.orderId}
                className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-2.5 py-2 dark:bg-slate-900"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-slate-800 dark:text-slate-200">
                    {occurrence.branchName}
                  </p>
                  <p className="font-mono text-[10px] text-slate-400">{occurrence.tid}</p>
                </div>
                <QuantityField
                  line={occurrence.line}
                  value={quantityFor(selection, occurrence.orderId, occurrence.line.orderItemId)}
                  onChange={(quantity) =>
                    onSelectionChange(
                      setLineQuantity(selection, occurrence.orderId, occurrence.line.orderItemId, quantity),
                    )
                  }
                  labelSuffix={`${occurrence.branchName}, ${group.productName}`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function BranchOrderRow({
  order,
  selection,
  onSelectionChange,
}: Readonly<{
  order: RefundableOrder
  selection: RefundSelection
  onSelectionChange: (selection: RefundSelection) => void
}>) {
  const [expanded, setExpanded] = useState(false)
  const lines = linesFor(selection, order.orderId)
  const selectedCount = order.lines.filter((line) => (lines[line.orderItemId] ?? 0) > 0).length
  const subtotal = orderSubtotalCents(selection, order)

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 p-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/50"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {order.branchName}
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">
            {order.tid} · {formatPKR(order.remainingRefundableCents / 100)} refundable
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {selectedCount > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {selectedCount} line{selectedCount === 1 ? "" : "s"} · {formatPKR(subtotal / 100)}
            </Badge>
          )}
          <span className="text-xs text-slate-400">{expanded ? "Hide" : "Choose items"}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-100 p-3 dark:border-slate-800/70">
          <ul className="space-y-2">
            {order.lines.map((line) => (
              <li
                key={line.orderItemId}
                className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-2.5 py-2 dark:bg-slate-900"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-slate-800 dark:text-slate-200">
                    {line.productName}
                  </p>
                  <p className="text-[10px] text-slate-400">
                    {formatQuantity(line.quantityRemaining)} of {formatQuantity(line.quantityOrdered)}{" "}
                    {line.unit || "units"} left · {formatPKR(line.priceCents / 100)} each
                  </p>
                </div>
                <QuantityField
                  line={line}
                  value={lines[line.orderItemId] ?? 0}
                  onChange={(quantity) =>
                    onSelectionChange(setLineQuantity(selection, order.orderId, line.orderItemId, quantity))
                  }
                  labelSuffix={`${order.branchName}, ${line.productName}`}
                />
              </li>
            ))}
          </ul>
          {selectedCount > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 h-7 text-xs text-slate-500"
              onClick={() => onSelectionChange(clearOrder(selection, order.orderId))}
            >
              Clear this branch
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function QuantityField({
  line,
  value,
  onChange,
  labelSuffix,
}: Readonly<{
  line: RefundableLine
  value: number
  onChange: (quantity: number) => void
  labelSuffix: string
}>) {
  return (
    <Input
      type="number"
      inputMode="decimal"
      min={0}
      max={line.quantityRemaining}
      step={stepForLine(line)}
      value={value === 0 ? "" : value}
      placeholder="0"
      aria-label={`Refund quantity for ${labelSuffix}`}
      className="h-8 w-24 shrink-0 text-right"
      onChange={(event) => onChange(clampToRemaining(line, parseQuantity(event.target.value)))}
    />
  )
}

function IneligibleList({
  orders,
}: Readonly<{ orders: GroupRefundWorkspace["ineligible"] }>) {
  if (orders.length === 0) return null

  return (
    <details className="rounded-xl border border-slate-200 dark:border-slate-800">
      <summary className="cursor-pointer px-3 py-2.5 text-xs font-medium text-slate-600 dark:text-slate-300">
        {orders.length} branch order{orders.length === 1 ? "" : "s"} cannot be refunded right now
      </summary>
      <ul className="space-y-1.5 border-t border-slate-100 p-3 dark:border-slate-800/70">
        {orders.map((order) => (
          <li key={order.orderId} className="text-xs">
            <span className="font-medium text-slate-800 dark:text-slate-200">{order.branchName}</span>
            <span className="ml-1.5 font-mono text-[10px] text-slate-400">{order.tid}</span>
            <p className="text-slate-500 dark:text-slate-400">{order.reason}</p>
          </li>
        ))}
      </ul>
    </details>
  )
}

function ReasonStep({
  reason,
  onChange,
}: Readonly<{ reason: string; onChange: (reason: string) => void }>) {
  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="group-refund-reason" className="text-sm">
          Why is this refund being requested?
        </Label>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          The same reason is recorded against every branch order in this request, and is what the
          administrator sees when reviewing it.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {QUICK_REASONS.map((quick) => (
          <button
            key={quick}
            type="button"
            onClick={() => onChange(quick)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition",
              reason === quick
                ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300"
                : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800/60",
            )}
          >
            {quick}
          </button>
        ))}
      </div>

      <Textarea
        id="group-refund-reason"
        value={reason}
        maxLength={MAX_REASON_LENGTH}
        rows={4}
        placeholder="Add any detail the administrator will need…"
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="text-right text-[11px] text-slate-400">
        {reason.length}/{MAX_REASON_LENGTH}
      </p>
    </div>
  )
}

function ReviewStep({
  selection,
  orders,
  reason,
}: Readonly<{ selection: RefundSelection; orders: RefundableOrder[]; reason: string }>) {
  const selectedOrders = orders.filter((order) => Object.keys(linesFor(selection, order.orderId)).length > 0)

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Reason</p>
        <p className="mt-1 whitespace-pre-line text-sm text-slate-800 dark:text-slate-200">{reason}</p>
      </div>

      {selectedOrders.map((order) => {
        const lines = linesFor(selection, order.orderId)
        return (
          <div key={order.orderId} className="rounded-xl border border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2.5 dark:border-slate-800/70">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {order.branchName}
                </p>
                <p className="font-mono text-[10px] text-slate-400">{order.tid}</p>
              </div>
              <p className="shrink-0 font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                {formatPKR(orderSubtotalCents(selection, order) / 100)}
              </p>
            </div>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {order.lines
                .filter((line) => (lines[line.orderItemId] ?? 0) > 0)
                .map((line) => (
                  <li key={line.orderItemId} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                    <span className="min-w-0 truncate text-slate-700 dark:text-slate-300">
                      {line.productName}
                    </span>
                    <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                      {formatQuantity(lines[line.orderItemId])} {line.unit || ""}
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        )
      })}

      <p className="flex items-start gap-2 rounded-lg bg-amber-50/70 p-3 text-xs text-slate-600 dark:bg-amber-950/20 dark:text-slate-300">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        Submitting raises one refund request per branch order. An administrator reviews each of them
        — nothing is refunded until they approve it.
      </p>
    </div>
  )
}

/**
 * What happened, branch by branch. Branch orders are written independently, so
 * a submission can partly succeed; the skipped ones carry the server's reason
 * because that is what the user needs in order to act on them.
 */
function RefundResult({ submission }: Readonly<{ submission: GroupRefundSubmission }>) {
  const requested = submission.results.filter((result) => result.status === "requested")
  const skipped = submission.results.filter((result) => result.status === "skipped")

  return (
    <div className="space-y-4">
      <div
        className={cn(
          "flex items-start gap-3 rounded-xl border p-4",
          skipped.length === 0
            ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/60 dark:bg-emerald-950/20"
            : "border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20",
        )}
      >
        {skipped.length === 0 ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        )}
        <div>
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {skipped.length === 0
              ? "Refund request submitted"
              : `Submitted — ${skipped.length} branch${skipped.length === 1 ? "" : "es"} skipped`}
          </p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {requested.length} branch order{requested.length === 1 ? "" : "s"} ·{" "}
            {formatPKR(submission.totalAmountCents / 100)} awaiting administrator review
          </p>
        </div>
      </div>

      {requested.length > 0 && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800">
          <p className="border-b border-slate-100 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:border-slate-800/70">
            <Layers className="mr-1 inline h-3 w-3" />
            Requests raised
          </p>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800/70">
            {requested.map((result) => (
              <li key={result.orderId} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-slate-800 dark:text-slate-200">
                    {result.branchName}
                  </p>
                  <p className="font-mono text-[10px] text-slate-400">
                    {result.status === "requested" ? result.refundNumber : null}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-xs text-slate-700 dark:text-slate-300">
                  {result.status === "requested" ? formatPKR(result.amountCents / 100) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {skipped.length > 0 && (
        <div className="rounded-xl border border-rose-200 dark:border-rose-900/60">
          <p className="border-b border-rose-100 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-rose-600 dark:border-rose-900/50 dark:text-rose-400">
            Not requested
          </p>
          <ul className="divide-y divide-rose-100 dark:divide-rose-900/40">
            {skipped.map((result) => (
              <li key={result.orderId} className="px-3 py-2">
                <p className="text-xs font-medium text-slate-800 dark:text-slate-200">
                  {result.branchName}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  {result.status === "skipped" ? result.reason : null}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
