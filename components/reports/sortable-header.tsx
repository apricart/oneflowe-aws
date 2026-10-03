"use client"

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"
import { useCallback, useState, type ReactNode } from "react"

import { nextSortState, type SortDirection, type SortState } from "@/lib/table-sort"
import { cn } from "@/lib/utils"

/**
 * Column sort state for one table. `toggleSort` flips the sorted column or
 * starts a new one at its first direction (see `nextSortState`).
 */
export function useTableSort<K extends string>(initial: SortState<K> = null): {
  sort: SortState<K>
  toggleSort: (key: K, firstDirection?: SortDirection) => void
} {
  const [sort, setSort] = useState<SortState<K>>(initial)
  const toggleSort = useCallback((key: K, firstDirection?: SortDirection) => {
    setSort((current) => nextSortState(current, key, firstDirection))
  }, [])
  return { sort, toggleSort }
}

/** `aria-sort` for the header cell that holds a `SortableHeader`. */
export function ariaSortFor<K extends string>(
  sort: SortState<K>,
  key: K,
): "ascending" | "descending" | undefined {
  if (sort?.key !== key) return undefined
  return sort.direction === "asc" ? "ascending" : "descending"
}

/**
 * The clickable label inside a header cell, styled after the Budgets table:
 * a faded ⇅ on a column that is not sorted, ↑ or ↓ on the one that is. It
 * inherits the cell's type styles, so each table keeps its own header look;
 * put `aria-sort={ariaSortFor(sort, key)}` on the cell itself.
 *
 * Numeric and date columns pass `firstDirection="desc"` so the first click
 * shows the largest or newest first.
 */
export function SortableHeader<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  firstDirection = "asc",
  className,
}: Readonly<{
  label: ReactNode
  sortKey: K
  sort: SortState<K>
  onSort: (key: K, firstDirection?: SortDirection) => void
  firstDirection?: SortDirection
  className?: string
}>) {
  const active = sort?.key === sortKey
  let icon = <ArrowUpDown className="h-3 w-3 shrink-0 opacity-40" aria-hidden />
  if (active) {
    icon = sort.direction === "asc"
      ? <ArrowUp className="h-3 w-3 shrink-0" aria-hidden />
      : <ArrowDown className="h-3 w-3 shrink-0" aria-hidden />
  }
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey, firstDirection)}
      className={cn(
        "inline-flex max-w-full cursor-pointer select-none items-center gap-1 rounded text-inherit [text-transform:inherit] transition-colors hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:text-slate-200",
        className,
      )}
    >
      {label}
      {icon}
    </button>
  )
}
