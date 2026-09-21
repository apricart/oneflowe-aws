"use client"

import { AlertTriangle, GitCompareArrows, X } from "lucide-react"

import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import type { ItemComparisonRow } from "@/lib/budget-burn-item-comparison"
import { useAPI } from "@/lib/hooks/use-api"
import { ChartMessage, countShort, money } from "./chart-kit"
import {
  monthLabel,
  signedPercent,
  type BudgetBurnItemDrillSelection,
} from "./budget-burn-watchlist"

type ItemComparisonResponse = {
  userId: string
  branchId: number
  month: string
  windows: {
    current: { startDate: string; endDate: string; complete: boolean }
    prior: { month: string; startDate: string; endDate: string }
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

function previousMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number)
  const previous = new Date(Date.UTC(year, monthNumber - 2, 1))
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`
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

  return (
    <Card className="overflow-hidden ring-1 ring-indigo-200 dark:ring-indigo-900">
      <CardHeader className="gap-1 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
              <GitCompareArrows className="h-4 w-4 text-indigo-600" aria-hidden />
              Item-wise MoM comparison
            </h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {selection.requesterName} at {selection.branchName}: {monthLabel(selection.month)} against the same window in {monthLabel(data?.windows.prior.month ?? previousMonth(selection.month))}.
              {" "}Orders counted as consumed, including pending orders, are included to match the MoM figure you opened.
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
            <Total term={monthLabel(data.month)} value={money(data.currentTotalSpendCents)} />
            <Total term={monthLabel(data.windows.prior.month)} value={money(data.priorTotalSpendCents)} />
          </dl>
        ) : null}

        {isLoading ? <Skeleton className="h-[220px] w-full rounded-lg" /> : null}
        {!isLoading && requestError ? <ChartMessage tone="error" message={requestError} /> : null}
        {!isLoading && !requestError && rows.length === 0 ? (
          <ChartMessage tone="empty" message="No consumed items were found for this requester in either month." />
        ) : null}
        {!isLoading && !requestError && rows.length > 0 ? <ItemTable rows={rows} /> : null}

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

function ItemTable({ rows }: Readonly<{ rows: ItemComparisonRow[] }>) {
  const columns = ["Product", "Unit", "Qty this month", "Qty last month", "Δ Qty", "Δ%", "Spend this month", "Spend last month"]
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
