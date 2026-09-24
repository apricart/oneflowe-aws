"use client"

import { AlertTriangle, GitCompareArrows, X } from "lucide-react"

import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { BUDGET_BURN_TREND_MONTHS } from "@/lib/budget-burn-risk"
import type { ItemComparisonRow } from "@/lib/budget-burn-item-comparison"
import { useAPI } from "@/lib/hooks/use-api"
import { ChartMessage, countShort, money } from "./chart-kit"
import {
  monthRangeLabel,
  signedPercent,
  type BudgetBurnItemDrillSelection,
} from "./budget-burn-watchlist"

type ItemComparisonWindow = { startMonth: string; endMonth: string; startDate: string; endDate: string }

type ItemComparisonResponse = {
  userId: string
  branchId: number
  month: string
  windows: {
    months: number
    current: ItemComparisonWindow & { complete: boolean }
    prior: ItemComparisonWindow
  }
  items: ItemComparisonRow[]
  currentTotalSpendCents: number
  priorTotalSpendCents: number
  truncated: boolean
  error?: string
}

function signedQuantity(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0"
  return `${value > 0 ? "+" : "-"}${countShort(Math.abs(value))}`
}

/**
 * The two runs of months the panel compares, derived locally only so the
 * heading can be drawn before the response lands. The server's own
 * `windows.trend` is authoritative and replaces this the moment it arrives.
 */
function fallbackRanges(month: string, span: number): { current: [string, string]; prior: [string, string] } {
  const [year, monthNumber] = month.split("-").map(Number)
  const shift = (delta: number) => {
    const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1))
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`
  }
  return {
    current: [shift(-(span - 1)), month],
    prior: [shift(-(2 * span - 1)), shift(-span)],
  }
}

export function BudgetBurnItemComparisonPanel({ selection, onClose }: Readonly<{
  selection: BudgetBurnItemDrillSelection
  onClose: () => void
}>) {
  const params = new URLSearchParams({
    userId: selection.userId,
    branchIds: String(selection.branchId),
    month: selection.month,
  })
  const url = `/api/v1/analytics/executive/budget-burn/item-comparison?${params.toString()}`
  const { data, error, isLoading } = useAPI<ItemComparisonResponse>(url)
  const requestError = error
    ? "The item comparison could not be loaded. Your session may have expired, or the selected month returned an error."
    : data?.error ?? null
  const rows = data?.items ?? []
  const fallback = fallbackRanges(selection.month, BUDGET_BURN_TREND_MONTHS)
  const currentRange = data
    ? monthRangeLabel(data.windows.current.startMonth, data.windows.current.endMonth)
    : monthRangeLabel(...fallback.current)
  const priorRange = data
    ? monthRangeLabel(data.windows.prior.startMonth, data.windows.prior.endMonth)
    : monthRangeLabel(...fallback.prior)
  const span = data?.windows.months ?? BUDGET_BURN_TREND_MONTHS

  return (
    <Card className="overflow-hidden ring-1 ring-indigo-200 dark:ring-indigo-900">
      <CardHeader className="gap-1 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
              <GitCompareArrows className="h-4 w-4 text-indigo-600" aria-hidden />
              Item-wise {span}-month comparison
            </h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {selection.requesterName} at {selection.branchName}: {currentRange} against the equal-length window before it, {priorRange}.
              {" "}Orders counted as consumed, including pending orders, are included to match the {span}M figure you opened.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
          >
            <X className="h-3 w-3" aria-hidden />
            Close
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {data && !requestError ? (
          <dl className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/50">
            <Total term={currentRange} value={money(data.currentTotalSpendCents)} />
            <Total term={priorRange} value={money(data.priorTotalSpendCents)} />
          </dl>
        ) : null}

        {isLoading ? <Skeleton className="h-[220px] w-full rounded-lg" /> : null}
        {!isLoading && requestError ? <ChartMessage tone="error" message={requestError} /> : null}
        {!isLoading && !requestError && rows.length === 0 ? (
          <ChartMessage tone="empty" message="No consumed items were found for this requester in either window." />
        ) : null}
        {!isLoading && !requestError && rows.length > 0 ? <ItemTable rows={rows} span={span} /> : null}

        {data?.truncated && !requestError ? (
          <p className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            The comparison hit its row cap; the smallest product totals may be missing.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function Total({ term, value }: Readonly<{ term: string; value: string }>) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{term}</dt>
      <dd className="text-sm font-bold tabular-nums text-slate-900 dark:text-slate-100">{value}</dd>
    </div>
  )
}

function ItemTable({ rows, span }: Readonly<{ rows: ItemComparisonRow[]; span: number }>) {
  const columns = ["Product", "Unit", `Qty last ${span}M`, `Qty prior ${span}M`, "Δ Qty", "Δ%", `Spend last ${span}M`, `Spend prior ${span}M`]
  return (
    <div className="max-h-[420px] overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-800">
          <tr>
            {columns.map((column, index) => (
              <th key={column} scope="col" className={`whitespace-nowrap px-3 py-2 font-semibold text-slate-600 dark:text-slate-300 ${index < 2 ? "text-left" : "text-right"}`}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.productId ?? "unknown"}:${row.unit}`} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-3 py-1.5 font-medium text-slate-800 dark:text-slate-200">{row.productName}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-slate-600 dark:text-slate-400">{row.unit}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{countShort(row.currentQuantity)}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{countShort(row.priorQuantity)}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right font-semibold tabular-nums">{signedQuantity(row.deltaQuantity)}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{signedPercent(row.deltaPct, 1)}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{money(row.currentSpendCents)}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{money(row.priorSpendCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
