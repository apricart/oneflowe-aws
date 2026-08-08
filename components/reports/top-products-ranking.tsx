"use client"

import {
  CircleDollarSign,
  Loader2,
  PackageCheck,
  ShoppingCart,
  Trophy,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  productPerformanceMetric,
  type ProductPerformanceRankBy,
  type ProductPerformanceRankingRow,
} from "@/lib/product-performance-ranking"
import { cn, formatPKR } from "@/lib/utils"

export type TopProductRow = ProductPerformanceRankingRow & {
  productId: number
  productCode?: string | null
  productName?: string | null
  unit?: string | null
}

type TopProductsRankingProps = {
  products: TopProductRow[]
  rankBy: ProductPerformanceRankBy
  pricesHidden: boolean
  valueLabel: string
  isLoading: boolean
  error?: string | null
  onRankByChange: (rankBy: ProductPerformanceRankBy) => void
}

const numberFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 3,
})

const rankStyles = [
  "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
]

function metricLabel(rankBy: ProductPerformanceRankBy, valueLabel: string) {
  if (rankBy === "fulfilledQty") return "Fulfilled quantity"
  if (rankBy === "orderCount") return "Unique orders"
  return valueLabel
}

function formatMetric(
  product: TopProductRow,
  rankBy: ProductPerformanceRankBy,
) {
  const value = productPerformanceMetric(product, rankBy)
  return rankBy === "netValue"
    ? formatPKR(value / 100)
    : numberFormat.format(value)
}

export function TopProductsRanking({
  products,
  rankBy,
  pricesHidden,
  valueLabel,
  isLoading,
  error,
  onRankByChange,
}: TopProductsRankingProps) {
  const maximumMetric = Math.max(
    ...products.map((product) => productPerformanceMetric(product, rankBy)),
    0,
  )
  const metrics: Array<{
    key: ProductPerformanceRankBy
    label: string
    icon: typeof CircleDollarSign
  }> = [
    ...(!pricesHidden
      ? [{ key: "netValue" as const, label: valueLabel, icon: CircleDollarSign }]
      : []),
    { key: "fulfilledQty", label: "Fulfilled Qty", icon: PackageCheck },
    { key: "orderCount", label: "Order Count", icon: ShoppingCart },
  ]

  return (
    <section
      aria-labelledby="top-products-title"
      className="border-b border-slate-100 bg-gradient-to-br from-indigo-50/60 via-white to-violet-50/40 px-5 py-5 dark:border-slate-800 dark:from-indigo-950/15 dark:via-slate-900 dark:to-violet-950/10"
    >
      <div className="mb-4 flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-lg shadow-amber-500/20">
            <Trophy className="h-4 w-4" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h4
                id="top-products-title"
                className="text-sm font-black uppercase tracking-tight text-slate-900 dark:text-white"
              >
                Top 10 Products
              </h4>
              <Badge
                variant="secondary"
                className="rounded-full bg-indigo-100 px-2 text-[9px] font-black uppercase tracking-wider text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
              >
                Live ranking
              </Badge>
            </div>
            <p className="mt-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400">
              Ranked by {metricLabel(rankBy, valueLabel).toLowerCase()} for the report filters above.
            </p>
          </div>
        </div>

        <div
          aria-label="Top product ranking metric"
          className="flex w-full flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white/80 p-1 shadow-sm dark:border-slate-700 dark:bg-slate-950/70 lg:w-auto"
        >
          {metrics.map(({ key, label, icon: Icon }) => (
            <Button
              key={key}
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={rankBy === key}
              onClick={() => onRankByChange(key)}
              className={cn(
                "h-7 flex-1 gap-1.5 rounded-lg px-2.5 text-[9px] font-black uppercase tracking-wider transition-all lg:flex-none",
                rankBy === key
                  ? "bg-indigo-600 text-white shadow-sm hover:bg-indigo-700 hover:text-white"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white",
              )}
            >
              <Icon className="h-3 w-3" />
              {label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex min-h-40 items-center justify-center rounded-2xl border border-dashed border-indigo-200 bg-white/50 dark:border-indigo-900 dark:bg-slate-950/30">
          <div className="flex items-center gap-2 text-xs font-bold text-indigo-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Updating ranking…
          </div>
        </div>
      ) : error ? (
        <div className="flex min-h-32 items-center justify-center rounded-2xl border border-dashed border-rose-200 bg-rose-50/50 px-4 text-center text-xs font-bold text-rose-600 dark:border-rose-900 dark:bg-rose-950/10 dark:text-rose-400">
          {error}
        </div>
      ) : products.length === 0 ? (
        <div className="flex min-h-32 items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white/50 px-4 text-center text-xs font-semibold text-slate-400 dark:border-slate-800 dark:bg-slate-950/30">
          No completed product activity matches the selected filters.
        </div>
      ) : (
        <ol className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
          {products.map((product, index) => {
            const metric = productPerformanceMetric(product, rankBy)
            const barWidth = maximumMetric > 0
              ? Math.max((metric / maximumMetric) * 100, 2)
              : 0
            const qtyOrdered = Number(product.qtyOrdered) || 0
            const qtyRefunded = Number(product.qtyRefunded) || 0
            const refundRate = qtyOrdered > 0
              ? (qtyRefunded / qtyOrdered) * 100
              : 0

            return (
              <li
                key={product.productId}
                className="group relative isolate overflow-hidden rounded-xl border border-slate-200/80 bg-white px-3 py-3 shadow-sm transition-colors hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-950/70 dark:hover:border-indigo-700"
              >
                <div
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 -z-10 bg-gradient-to-r from-indigo-100/70 to-transparent transition-[width] duration-500 dark:from-indigo-950/50"
                  style={{ width: `${barWidth}%` }}
                />
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[10px] font-black",
                      rankStyles[index] || "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300",
                    )}
                  >
                    {index + 1}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <p
                        className="truncate text-xs font-black uppercase text-slate-900 dark:text-white"
                        title={product.productName || "Unknown product"}
                      >
                        {product.productName || "Unknown product"}
                      </p>
                      {product.unit && (
                        <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[8px] font-bold uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                          {product.unit}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[9px] text-slate-400">
                      {product.productCode || "No product code"}
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-xs font-black text-indigo-700 dark:text-indigo-300">
                      {formatMetric(product, rankBy)}
                    </p>
                    <p className="mt-0.5 text-[8px] font-black uppercase tracking-wider text-slate-400">
                      {metricLabel(rankBy, valueLabel)}
                    </p>
                  </div>
                </div>

                <div className="ml-10 mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[9px] font-bold text-slate-500 dark:text-slate-400">
                  <span>
                    {numberFormat.format(Number(product.qtyFulfilled) || 0)} fulfilled
                  </span>
                  <span>
                    {numberFormat.format(Number(product.totalOrders) || 0)} orders
                  </span>
                  <span className={cn(refundRate > 0 && "text-rose-500")}>
                    {refundRate.toFixed(1)}% refunded
                  </span>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
