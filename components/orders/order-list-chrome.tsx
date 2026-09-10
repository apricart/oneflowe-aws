"use client"

import { ChevronLeft, ChevronRight, Package, RefreshCw, Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ListSkeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

/**
 * The chrome every scoped order list wears: a row of status pills, a search
 * box, a refresh control, a pager, and the three states a fetched list can be
 * in.
 *
 * The Group User's approval workspace and the Group Order Portal's storefront
 * each show a list of orders drawn from `/api/v1/orders` under a different
 * filter. Only the rows differ; the controls around them are the same, and a
 * second copy of them would drift — a status added in one place and not the
 * other reads as a bug in whichever screen is looked at second.
 *
 * Deliberately presentational: no fetching, no endpoint knowledge, no
 * authorization. Each caller owns its own query and its own row rendering.
 */

export type OrderStatusPillOption<T extends string> = readonly [T, string]

export function OrderStatusPills<T extends string>({
  value,
  options,
  onChange,
  label = "Filter orders by status",
}: Readonly<{
  value: T
  options: ReadonlyArray<OrderStatusPillOption<T>>
  onChange: (next: T) => void
  label?: string
}>) {
  return (
    <div
      className="flex items-center overflow-x-auto rounded-xl border border-slate-200/60 bg-slate-100/60 p-1 dark:border-slate-700/50 dark:bg-slate-800/50"
      role="group"
      aria-label={label}
    >
      {options.map(([optionValue, optionLabel]) => (
        <Button
          key={optionValue}
          type="button"
          size="sm"
          variant={value === optionValue ? "secondary" : "ghost"}
          aria-pressed={value === optionValue}
          onClick={() => onChange(optionValue)}
          className={cn(
            "h-8 shrink-0 rounded-lg px-3 text-xs font-bold",
            value === optionValue
              ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white"
              : "text-slate-500 hover:text-slate-900 dark:text-slate-400",
          )}
        >
          {optionLabel}
        </Button>
      ))}
    </div>
  )
}

export function OrderListSearch({
  value,
  onChange,
  onRefresh,
  refreshing,
  label,
  placeholder = "Search by TID or cost center",
}: Readonly<{
  value: string
  onChange: (next: string) => void
  onRefresh: () => void
  refreshing: boolean
  label: string
  placeholder?: string
}>) {
  return (
    <div className="flex items-center gap-2">
      <div className="relative w-full sm:w-64">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={label}
          className="h-8 rounded-xl pl-9 text-xs"
        />
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onRefresh}
        className="h-8 gap-2 rounded-full"
      >
        <RefreshCw className={cn("h-3.5 w-3.5 text-slate-500", refreshing && "animate-spin text-indigo-500")} />
        <span className="hidden sm:inline">Refresh</span>
      </Button>
    </div>
  )
}

export function OrderListPager({
  page,
  totalPages,
  total,
  busy,
  onChange,
}: Readonly<{
  page: number
  totalPages: number
  total: number
  busy: boolean
  onChange: (next: number) => void
}>) {
  // Without a pager the list silently showed only its first page, so a caller
  // with more than a page of orders could not reach the rest.
  if (totalPages <= 1) return null

  return (
    <nav aria-label="Order pages" className="flex items-center justify-between gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 gap-1 rounded-full text-xs"
        disabled={page <= 1 || busy}
        onClick={() => onChange(Math.max(1, page - 1))}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Previous
      </Button>
      <span className="text-xs text-slate-500 dark:text-slate-400">
        Page {page} of {totalPages}
        {total > 0 && <> · {total} order{total === 1 ? "" : "s"}</>}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 gap-1 rounded-full text-xs"
        disabled={page >= totalPages || busy}
        onClick={() => onChange(page + 1)}
      >
        Next
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </nav>
  )
}

/**
 * Loading, error and empty are rendered explicitly rather than left to an
 * empty table, so a failed fetch is never mistaken for "no orders".
 */
export function OrderListBody({
  loading,
  error,
  isEmpty,
  emptyMessage,
  children,
}: Readonly<{
  loading: boolean
  error: boolean
  isEmpty: boolean
  emptyMessage: string
  children: React.ReactNode
}>) {
  if (loading) return <div className="p-6"><ListSkeleton rows={5} /></div>

  if (error) {
    return (
      <p role="alert" className="p-6 text-sm text-slate-700 dark:text-slate-300">
        Orders could not be loaded. Please try again.
      </p>
    )
  }

  if (isEmpty) {
    return (
      <div className="p-10 text-center">
        <Package className="mx-auto mb-3 h-9 w-9 text-slate-300 dark:text-slate-700" />
        <p className="text-sm text-slate-500 dark:text-slate-400">{emptyMessage}</p>
      </div>
    )
  }

  return <>{children}</>
}
