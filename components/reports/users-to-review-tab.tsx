"use client"

import * as React from "react"
import { RefreshCw, SlidersHorizontal } from "lucide-react"

import { BranchFilter } from "@/components/reports/branch-filter"
import { GroupFilter } from "@/components/reports/group-filter"
import { OrganizationFilter } from "@/components/reports/organization-filter"
import {
  BudgetBurnDrillNote,
  BudgetBurnWatchlist,
  type BudgetBurnDrillSelection,
  type BudgetBurnItemDrillSelection,
} from "@/components/reports/executive/budget-burn-watchlist"
import { BudgetBurnItemComparisonPanel } from "@/components/reports/executive/budget-burn-item-comparison"
import { ExecutiveVizStyles, VIZ_CLASS } from "@/components/reports/executive/chart-kit"
import { DrillDownPanel } from "@/components/reports/executive/drill-down-panel"
import type { ExecutiveFilterState } from "@/components/reports/executive/executive-filters"
import { Button } from "@/components/ui/button"
import { isBudgetBurnRole } from "@/lib/budget-burn-risk"
import { cn } from "@/lib/utils"

type UsersToReviewTabProps = Readonly<{
  role: string | undefined
  organizationId?: string | number | null
  branchIds?: string[]
}>

function scopeFilters(organizationId?: string | number | null, branchIds: string[] = []): ExecutiveFilterState {
  return {
    startDate: "",
    endDate: "",
    organizationIds: organizationId ? [String(organizationId)] : [],
    groupIds: [],
    branchIds,
    categoryIds: [],
  }
}

/**
 * The relocated Users to review surface.
 *
 * The browser gate mirrors the API's `BUDGET_BURN_ROLES` gate for a clear
 * reader experience; it is not the security boundary. Every watchlist and
 * drill-down request still resolves the signed-in user from the database and
 * applies the tenant/branch fence on the server.
 */
export function UsersToReviewTab({ role, organizationId, branchIds = [] }: UsersToReviewTabProps) {
  const normalizedRole = role?.toUpperCase()
  const defaultOrganizationId = organizationId ? String(organizationId) : null
  const branchKey = branchIds.join(",")
  const [filters, setFilters] = React.useState<ExecutiveFilterState>(() => (
    scopeFilters(defaultOrganizationId, branchIds)
  ))
  const [burnDrill, setBurnDrill] = React.useState<BudgetBurnDrillSelection | null>(null)
  const [burnItemsDrill, setBurnItemsDrill] = React.useState<BudgetBurnItemDrillSelection | null>(null)

  React.useEffect(() => {
    const nextBranches = branchKey ? branchKey.split(",") : []
    setFilters(scopeFilters(defaultOrganizationId, nextBranches))
    setBurnDrill(null)
    setBurnItemsDrill(null)
  }, [branchKey, defaultOrganizationId])

  const updateScope = React.useCallback((next: Partial<ExecutiveFilterState>) => {
    setFilters((current) => ({ ...current, ...next }))
    setBurnDrill(null)
    setBurnItemsDrill(null)
  }, [])

  const resetScope = React.useCallback(() => {
    setFilters(scopeFilters(defaultOrganizationId, branchKey ? branchKey.split(",") : []))
    setBurnDrill(null)
    setBurnItemsDrill(null)
  }, [branchKey, defaultOrganizationId])

  if (!isBudgetBurnRole(normalizedRole)) return null

  return (
    <div className={cn("space-y-4", VIZ_CLASS)}>
      <ExecutiveVizStyles />

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white/60 p-4 dark:border-slate-700 dark:bg-slate-900/40">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <SlidersHorizontal className="h-4 w-4 text-indigo-600" aria-hidden />
            Review scope
          </h3>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Narrow every watchlist value and drill-down by organization, group, or branch.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {normalizedRole === "SUPER_ADMIN" ? (
            <OrganizationFilter
              selectedIds={filters.organizationIds}
              onChange={(organizationIds) => updateScope({ organizationIds, groupIds: [], branchIds: [] })}
              placeholder="All Organizations"
              maxSelect={1}
            />
          ) : null}
          <GroupFilter
            selectedIds={filters.groupIds}
            onChange={(groupIds) => updateScope({ groupIds, branchIds: [] })}
            organizationIds={filters.organizationIds}
            placeholder="All Groups"
          />
          <BranchFilter
            selectedIds={filters.branchIds}
            onChange={(nextBranchIds) => updateScope({ branchIds: nextBranchIds })}
            organizationIds={filters.organizationIds}
            groupIds={filters.groupIds}
            placeholder="All Branches"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={resetScope}
            className="h-10 w-10 rounded-xl text-slate-400 transition-all hover:bg-indigo-50/50 hover:text-indigo-500"
            aria-label="Reset review filters"
            title="Reset review filters"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>

      <BudgetBurnWatchlist
        filters={filters}
        onDrill={setBurnDrill}
        onDrillItems={setBurnItemsDrill}
        selectedKey={burnDrill ? `${burnDrill.target.key}:${burnDrill.target.narrow?.branchIds?.[0] ?? ""}` : null}
        selectedItemsKey={burnItemsDrill ? `${burnItemsDrill.userId}:${burnItemsDrill.branchId}:${burnItemsDrill.month}` : null}
      />

      {burnItemsDrill ? (
        <BudgetBurnItemComparisonPanel
          selection={burnItemsDrill}
          onClose={() => setBurnItemsDrill(null)}
        />
      ) : null}

      {burnDrill ? (
        <div className="space-y-2">
          <BudgetBurnDrillNote selection={burnDrill} onClose={() => setBurnDrill(null)} />
          <DrillDownPanel
            target={burnDrill.target}
            filters={burnDrill.filters}
            metric="spend"
            statuses={burnDrill.statuses}
            onClose={() => setBurnDrill(null)}
          />
        </div>
      ) : null}
    </div>
  )
}
