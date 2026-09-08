"use client"

import * as React from "react"
import { Ruler, X } from "lucide-react"

import { BranchFilter } from "@/components/reports/branch-filter"
import { OrganizationFilter } from "@/components/reports/organization-filter"
import { QuickDateRange, getDateRange, type RangeKey } from "@/components/reports/quick-date-range"
import { useAPI } from "@/lib/hooks/use-api"
import { MultiSelectFilter } from "@/components/reports/multi-select-filter"
import { cn } from "@/lib/utils"

/**
 * The one filter row above the charts.
 *
 * Only filters the caller is authorized to use are rendered: the organization
 * selector is a Super Admin control, because a Head Office user's tenant is
 * fixed on the server and a selector would only invite a request the API
 * discards. Hiding it is a convenience, not the control — the server rejects
 * the parameter either way.
 */

export type ExecutiveFilterState = {
  startDate: string
  endDate: string
  organizationIds: string[]
  branchIds: string[]
  categoryIds: string[]
  /**
   * Narrows every figure to these products. Set by the Explore workbench's
   * focus picker rather than the shared filter row, because it only makes sense
   * alongside a comparison that groups by something other than the product.
   */
  productIds?: string[]
  /**
   * Narrows every figure to these requesters. Set by the side-by-side screen's
   * "requesters to compare" picker, so the month and day panels answer for the
   * same people the requester panel ranks rather than for everyone.
   */
  userIds?: string[]
  unit: string | null
}

/** The default range, and the single source both the control and the page read. */
export const EXECUTIVE_DEFAULT_RANGE: RangeKey = "thisQuarter"

export function executiveDefaultDates() {
  const range = getDateRange(EXECUTIVE_DEFAULT_RANGE)
  const today = new Date().toISOString().split("T")[0]
  return { startDate: range?.start ?? today, endDate: range?.end ?? today }
}

export function ExecutiveFilters({ role, value, onChange, availableUnits, unitConflict }: Readonly<{
  role: string
  value: ExecutiveFilterState
  /**
   * Takes an updater, not a value.
   *
   * `QuickDateRange` reports a new start and a new end as two separate calls
   * inside one event. With a plain value both were built from the same stale
   * state and the second silently discarded the first, so picking a range moved
   * only the end date — which, since the end was already today, looked exactly
   * like the date filter doing nothing at all.
   */
  onChange: (next: (current: ExecutiveFilterState) => ExecutiveFilterState) => void
  availableUnits: string[]
  unitConflict: boolean
}>) {
  const isSuperAdmin = role === "SUPER_ADMIN"
  const organizationQuery = value.organizationIds.length > 0 ? value.organizationIds.join(",") : undefined

  const { data: categoryData } = useAPI<{ items?: Array<{ id: number; name: string }> }>("/api/v1/categories")
  const categories = (categoryData?.items || []).map((category) => ({
    id: String(category.id),
    label: category.name,
  }))

  const patch = (next: Partial<ExecutiveFilterState>) => onChange((current) => ({ ...current, ...next }))

  const hasFilters = value.branchIds.length > 0
    || value.categoryIds.length > 0
    || value.organizationIds.length > 0
    || Boolean(value.unit)

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white/60 p-3 dark:border-slate-700 dark:bg-slate-900/40">
      <QuickDateRange
        startDate={value.startDate}
        endDate={value.endDate}
        onStartDateChange={(startDate) => patch({ startDate })}
        onEndDateChange={(endDate) => patch({ endDate })}
        storageKey="executive-analytics-date-range"
        defaultRange={EXECUTIVE_DEFAULT_RANGE}
      />

      {isSuperAdmin ? (
        <OrganizationFilter
          selectedIds={value.organizationIds}
          onChange={(organizationIds) => patch({ organizationIds, branchIds: [] })}
          maxSelect={1}
        />
      ) : null}

      <BranchFilter
        selectedIds={value.branchIds}
        onChange={(branchIds) => patch({ branchIds })}
        organizationIds={value.organizationIds}
      />

      <MultiSelectFilter
        title="Categories"
        items={categories}
        selectedIds={value.categoryIds}
        onChange={(categoryIds) => patch({ categoryIds })}
        placeholder="All Categories"
        className="w-[220px]"
      />

      {/*
        The unit selector only appears when quantity would otherwise be
        meaningless. Litres and packs cannot be added, so rather than printing a
        nonsense total the Center asks which unit the reader means.
      */}
      {availableUnits.length > 1 ? (
        <div
          className={cn(
            "flex items-center gap-1 rounded-lg border px-2 py-1.5",
            unitConflict && !value.unit
              ? "border-amber-300 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-900/20"
              : "border-slate-200 dark:border-slate-700",
          )}
        >
          <Ruler className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
          <label htmlFor="executive-unit" className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Unit
          </label>
          <select
            id="executive-unit"
            value={value.unit ?? ""}
            onChange={(event) => patch({ unit: event.target.value || null })}
            className="bg-transparent text-xs font-semibold text-slate-700 outline-none dark:text-slate-200"
          >
            <option value="">Not selected</option>
            {availableUnits.map((unit) => (
              <option key={unit} value={unit}>{unit}</option>
            ))}
          </select>
        </div>
      ) : null}

      {hasFilters ? (
        <button
          type="button"
          onClick={() => onChange((current) => ({
            ...current, organizationIds: [], branchIds: [], categoryIds: [], unit: null,
          }))}
          className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-300"
        >
          <X className="h-3 w-3" aria-hidden />
          Clear
        </button>
      ) : null}
    </div>
  )
}

/** Serializes the filter state into the query string both endpoints accept. */
export function toQuery(filters: ExecutiveFilterState, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams()
  if (filters.startDate) params.set("startDate", filters.startDate)
  if (filters.endDate) params.set("endDate", filters.endDate)
  if (filters.organizationIds.length > 0) params.set("organizationIds", filters.organizationIds.join(","))
  if (filters.branchIds.length > 0) params.set("branchIds", filters.branchIds.join(","))
  if (filters.categoryIds.length > 0) params.set("categoryIds", filters.categoryIds.join(","))
  if (filters.productIds && filters.productIds.length > 0) params.set("productIds", filters.productIds.join(","))
  if (filters.userIds && filters.userIds.length > 0) params.set("userIds", filters.userIds.join(","))
  if (filters.unit) params.set("unit", filters.unit)
  Object.entries(extra).forEach(([key, entry]) => {
    if (entry) params.set(key, entry)
  })
  return params.toString()
}
