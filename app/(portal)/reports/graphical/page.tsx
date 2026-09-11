"use client"

import * as React from "react"
import { useSession } from "next-auth/react"
import { BarChart3, Compass, LayoutDashboard, LayoutGrid, ShieldAlert } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { useAPI } from "@/lib/hooks/use-api"
import { cn } from "@/lib/utils"
import { EXECUTIVE_ANALYTICS_ROLES } from "@/lib/executive-analytics"
import {
  ExecutiveVizStyles,
  VIZ_CLASS,
} from "@/components/reports/executive/chart-kit"
import {
  ExecutiveFilters,
  executiveDefaultDates,
  toQuery,
  type ExecutiveFilterState,
} from "@/components/reports/executive/executive-filters"
import { ExploreWorkspace } from "@/components/reports/executive/explore-workspace"
import { SideBySideWorkspace } from "@/components/reports/executive/side-by-side-workspace"
import {
  AttentionList,
  KpiRow,
  type AttentionItem,
  type ExecutiveKpis,
} from "@/components/reports/executive/summary-panels"
import {
  BranchCategoryHeatmap,
  BudgetVsActualChart,
  CategoryParetoChart,
  PriceVariancePanel,
  ProcurementTrendChart,
  StatusCompositionChart,
  UtilizationRankingChart,
  type BranchRow,
  type CategoryRow,
  type MatrixData,
  type PriceVarianceRow,
  type StatusBranch,
  type TrendPoint,
} from "@/components/reports/executive/overview-charts"

/**
 * Graphical Reports — the Executive Procurement Analytics Center.
 *
 * Two levels: an Overview that answers "what is happening right now?" in a
 * handful of high-value visuals, and an Explore workspace where a reader builds
 * a curated comparison without a developer adding a chart for it.
 *
 * The role check here decides what renders, never what is readable. Both
 * endpoints behind this page re-derive the caller's tenant and branch set from
 * their own user row and refuse anything else, so a hand-typed URL reaches the
 * same 403 the sidebar entry is hidden behind.
 */

type OverviewResponse = {
  scope: { role: string; organizationIds: number[]; branchCount: number; branches: Array<{ id: number; name: string }> }
  period: { startDate: string; endDate: string; previousStartDate: string; previousEndDate: string }
  quantityUnit: { selected: string | null; conflict: boolean; available: string[] }
  kpis: ExecutiveKpis
  branches: BranchRow[]
  trend: { current: TrendPoint[]; previous: TrendPoint[] }
  categories: CategoryRow[]
  categoryConcentration: { categoriesTo80: number; totalCategories: number }
  matrix: MatrixData
  statusByBranch: StatusBranch[]
  priceVariance: PriceVarianceRow[]
  attention: AttentionItem[]
  thresholds: { budgetWarningPct: number; priceSpreadPct: number }
  error?: string
}

/**
 * The three levels of the Center, in the order a reader moves through them:
 * what is happening, then how these things compare side by side, then an
 * open-ended question of their own.
 */
type AnalyticsTab = "overview" | "side-by-side" | "explore"

const ANALYTICS_TABS = [
  { id: "overview", label: "Executive Overview", icon: LayoutDashboard },
  { id: "side-by-side", label: "Compare Side by Side", icon: LayoutGrid },
  { id: "explore", label: "Explore & Compare", icon: Compass },
] as const satisfies ReadonlyArray<{ id: AnalyticsTab; label: string; icon: typeof LayoutDashboard }>

/**
 * The opening range comes from the same function the date control uses to
 * highlight a button, so the two cannot disagree. They previously did: the page
 * opened on six months while the control claimed "This Month".
 */
function defaultFilters(): ExecutiveFilterState {
  return {
    ...executiveDefaultDates(),
    organizationIds: [],
    branchIds: [],
    categoryIds: [],
    unit: null,
  }
}

export default function GraphicalReportsPage() {
  const { data: session, status } = useSession()
  const role = ((session?.user as { role?: string } | undefined)?.role || "").toUpperCase()
  const authorized = (EXECUTIVE_ANALYTICS_ROLES as readonly string[]).includes(role)

  const [tab, setTab] = React.useState<AnalyticsTab>("overview")
  const [filters, setFilters] = React.useState<ExecutiveFilterState>(defaultFilters)
  const [priceProduct, setPriceProduct] = React.useState<{ productId: number; unit: string; name?: string } | null>(null)

  const overviewUrl = authorized ? `/api/v1/analytics/executive/overview?${toQuery(filters)}` : null
  const { data, error, isLoading } = useAPI<OverviewResponse>(overviewUrl)

  const requestError = error
    ? "The analytics could not be loaded. Your session may have expired, or the selected range returned an error."
    : data?.error ?? null

  // Clicking a branch anywhere narrows every other visual to it — the same
  // filter the server already enforces, not a client-side hide.
  const selectBranch = React.useCallback((branchId: number) => {
    setFilters((current) => {
      const id = String(branchId)
      const already = current.branchIds.length === 1 && current.branchIds[0] === id
      return { ...current, branchIds: already ? [] : [id] }
    })
  }, [])

  const openPriceDrilldown = React.useCallback((productId: number, unit: string, name?: string) => {
    setPriceProduct({ productId, unit, name })
    setTab("explore")
  }, [])

  if (status === "loading") {
    return <div className="p-6 text-sm text-slate-500">Loading…</div>
  }

  if (!authorized) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="flex min-h-[240px] flex-col items-center justify-center gap-3 text-center">
            <ShieldAlert className="h-6 w-6 text-slate-400" aria-hidden />
            <h1 className="text-base font-semibold text-slate-800 dark:text-slate-200">
              Graphical Reports is not available for your role
            </h1>
            <p className="max-w-md text-xs text-slate-500 dark:text-slate-400">
              This report compares budgets and procurement across branches, and is limited to Super Admin and Head
              Office users.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const branches = data?.branches ?? []
  const warningPct = data?.thresholds?.budgetWarningPct ?? 90
  const priceSpreadPct = data?.thresholds?.priceSpreadPct ?? 15
  const selectedBranchId = filters.branchIds.length === 1 ? Number(filters.branchIds[0]) : null

  return (
    <div className={cn("space-y-4 p-4 md:p-6", VIZ_CLASS)}>
      <ExecutiveVizStyles />

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-slate-100">
            <BarChart3 className="h-5 w-5 text-indigo-600" aria-hidden />
            Graphical Reports
          </h1>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Executive procurement analytics — budget position, side-by-side comparison across people, branches and
            months, and the order lines behind any figure.
            {data ? ` Covering ${data.scope.branchCount} branch${data.scope.branchCount === 1 ? "" : "es"} in your scope.` : ""}
          </p>
        </div>

        <div role="tablist" aria-label="Analytics level" className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1 dark:border-slate-700 dark:bg-slate-800/60">
          {ANALYTICS_TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
                tab === entry.id
                  ? "bg-white text-indigo-600 shadow-sm ring-1 ring-slate-200 dark:bg-slate-700 dark:text-indigo-300 dark:ring-slate-600"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200",
              )}
            >
              <entry.icon className="h-3.5 w-3.5" aria-hidden />
              {entry.label}
            </button>
          ))}
        </div>
      </header>

      <ExecutiveFilters
        role={role}
        value={filters}
        onChange={setFilters}
        availableUnits={data?.quantityUnit.available ?? []}
        unitConflict={Boolean(data?.quantityUnit.conflict)}
      />

      {requestError ? (
        <Card>
          <CardContent className="flex items-center gap-2 py-4 text-xs text-rose-600 dark:text-rose-400">
            <ShieldAlert className="h-4 w-4" aria-hidden />
            {requestError}
          </CardContent>
        </Card>
      ) : null}

      {tab === "overview" ? (
        <div className="space-y-4">
          <KpiRow kpis={data?.kpis ?? null} loading={isLoading} />

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="space-y-4 xl:col-span-2">
              <BudgetVsActualChart
                rows={branches}
                loading={isLoading}
                error={requestError}
                onSelectBranch={selectBranch}
                selectedBranchId={selectedBranchId}
              />
              <ProcurementTrendChart
                current={data?.trend.current ?? []}
                previous={data?.trend.previous ?? []}
                loading={isLoading}
                error={requestError}
              />
            </div>
            <div className="space-y-4">
              <UtilizationRankingChart
                rows={branches}
                warningPct={warningPct}
                loading={isLoading}
                error={requestError}
              />
              <AttentionList
                items={data?.attention ?? []}
                loading={isLoading}
                onSelectBranch={selectBranch}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <CategoryParetoChart
              rows={data?.categories ?? []}
              categoriesTo80={data?.categoryConcentration.categoriesTo80 ?? 0}
              loading={isLoading}
              error={requestError}
              onSelectCategory={(key) => {
                if (key === "uncategorized") return
                setFilters((current) => ({
                  ...current,
                  categoryIds: current.categoryIds.includes(key) ? [] : [key],
                }))
              }}
            />
            <BranchCategoryHeatmap
              matrix={data?.matrix ?? { categories: [], rows: [] }}
              loading={isLoading}
              error={requestError}
            />
            <StatusCompositionChart
              branches={data?.statusByBranch ?? []}
              loading={isLoading}
              error={requestError}
            />
            <PriceVariancePanel
              rows={data?.priceVariance ?? []}
              thresholdPct={priceSpreadPct}
              loading={isLoading}
              error={requestError}
              onSelectProduct={(productId, unit) => {
                const row = data?.priceVariance.find((entry) => entry.productId === productId)
                openPriceDrilldown(productId, unit, row?.productName)
              }}
            />
          </div>
        </div>
      ) : null}

      {tab === "side-by-side" ? <SideBySideWorkspace filters={filters} /> : null}

      {tab === "explore" ? (
        <ExploreWorkspace
          filters={filters}
          priceProduct={priceProduct}
          onClearPriceProduct={() => setPriceProduct(null)}
        />
      ) : null}
    </div>
  )
}
