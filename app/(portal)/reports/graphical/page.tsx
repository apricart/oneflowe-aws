"use client"

import * as React from "react"
import { useSession } from "next-auth/react"
import { usePathname, useSearchParams } from "next/navigation"
import { Compass, LayoutDashboard, LayoutGrid, ShieldAlert } from "lucide-react"

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
 * The level is chosen from the sidebar — the Visualize group has one entry
 * per level — so the page carries no switch of its own; it reads `?tab=`,
 * names the level in its heading, and renders that level.
 *
 * The role check here decides what renders, never what is readable. Every
 * endpoint behind this page re-derives the caller's tenant and branch set from
 * their own user row — and, for a Group User, from their own assignment rows —
 * and refuses anything else, so a hand-typed URL reaches the same 403 the
 * sidebar entry is hidden behind.
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
 * what is happening, then how products, categories, people, branches and
 * months compare side by side, then an open-ended question of their own.
 *
 * The id is the `?tab=` value, so it is user-facing: `product-performance` is
 * the name the client gave that screen and what the sidebar links to. The
 * label is the page heading while that level is open.
 */
type AnalyticsTab = "overview" | "product-performance" | "explore"

/**
 * Whether the Explore & Compare workbench is offered.
 *
 * Withdrawn for now at the client's request — hidden, not removed, so that
 * flipping this back restores it whole. While it is withdrawn nothing reaches
 * it: the sidebar offers no entry for it, `?tab=explore` falls back to the
 * overview like any unknown value, and the Price Variance rows that opened it
 * with a product pre-selected are not clickable. A constant in code rather than an
 * environment variable, as `lib/password-change-policy.ts` argues: a
 * one-word change here goes through review and shows in history.
 * `page.test.tsx` pins what the reader gets while it is off.
 */
const EXPLORE_TAB_OFFERED = false

const ALL_ANALYTICS_TABS = [
  { id: "overview", label: "Executive Overview", icon: LayoutDashboard },
  { id: "product-performance", label: "Product Performance", icon: LayoutGrid },
  { id: "explore", label: "Explore & Compare", icon: Compass },
] as const satisfies ReadonlyArray<{ id: AnalyticsTab; label: string; icon: typeof LayoutDashboard }>

const ANALYTICS_TABS = ALL_ANALYTICS_TABS.filter((entry) => entry.id !== "explore" || EXPLORE_TAB_OFFERED)

const DEFAULT_TAB: AnalyticsTab = "overview"
const TAB_PARAM = "tab"

function isAnalyticsTab(value: string | null): value is AnalyticsTab {
  return ANALYTICS_TABS.some((entry) => entry.id === value)
}

/**
 * The tab, read from and written to `?tab=`.
 *
 * The URL is the single source of truth, so a sidebar link straight to one
 * level opens on it, a bookmark returns to it, and a link followed while the
 * page is already open — which changes only the search params — still
 * switches. An unknown value falls back to the overview rather than rendering
 * nothing.
 *
 * The sidebar is how a reader moves between levels; the page writes the URL
 * itself only when a visual leads into another level (the Price Variance
 * drill-down into Explore). It writes with the native History API rather than
 * `router.replace`: Next syncs `useSearchParams` from it without a round trip.
 */
function useAnalyticsTab(): [AnalyticsTab, (next: AnalyticsTab) => void] {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const requested = searchParams.get(TAB_PARAM)
  const tab = isAnalyticsTab(requested) ? requested : DEFAULT_TAB

  const setTab = React.useCallback((next: AnalyticsTab) => {
    const params = new URLSearchParams(searchParams.toString())
    if (next === DEFAULT_TAB) params.delete(TAB_PARAM)
    else params.set(TAB_PARAM, next)
    const query = params.toString()
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname)
  }, [pathname, searchParams])

  return [tab, setTab]
}

/**
 * The opening range comes from the same function the date control uses to
 * highlight a button, so the two cannot disagree. They previously did: the page
 * opened on six months while the control claimed "This Month".
 */
function defaultFilters(): ExecutiveFilterState {
  return {
    ...executiveDefaultDates(),
    organizationIds: [],
    groupIds: [],
    branchIds: [],
    categoryIds: [],
  }
}

/**
 * The Suspense boundary is for `useSearchParams`: without one, a prerender
 * would bail the whole page to the client. Same shape as the orders page.
 */
export default function GraphicalReportsPage() {
  return (
    <React.Suspense fallback={<div className="p-6 text-sm text-slate-500">Loading…</div>}>
      <GraphicalReportsContent />
    </React.Suspense>
  )
}

function GraphicalReportsContent() {
  const { data: session, status } = useSession()
  const role = ((session?.user as { role?: string } | undefined)?.role || "").toUpperCase()
  const authorized = (EXECUTIVE_ANALYTICS_ROLES as readonly string[]).includes(role)

  const [tab, setTab] = useAnalyticsTab()
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
  }, [setTab])

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
              This report compares budgets and procurement across branches, and is limited to Super Admin, Head
              Office and Group User accounts.
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
  // `tab` is always one of the offered levels — an unknown `?tab=` has already
  // fallen back to the default — so the lookup cannot miss.
  const level = ANALYTICS_TABS.find((entry) => entry.id === tab) ?? ANALYTICS_TABS[0]

  return (
    <div className={cn("space-y-4 p-4 md:p-6", VIZ_CLASS)}>
      <ExecutiveVizStyles />

      <header>
        <h1 className="flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-slate-100">
          <level.icon className="h-5 w-5 text-indigo-600" aria-hidden />
          {level.label}
        </h1>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Executive procurement analytics — budget position, product performance across products, categories, people,
          branches and months, and the order lines behind any figure.
          {data ? ` Covering ${data.scope.branchCount} branch${data.scope.branchCount === 1 ? "" : "es"} in your scope.` : ""}
        </p>
      </header>

      <ExecutiveFilters
        role={role}
        value={filters}
        onChange={setFilters}
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
              onSelectProduct={EXPLORE_TAB_OFFERED ? (productId, unit) => {
                const row = data?.priceVariance.find((entry) => entry.productId === productId)
                openPriceDrilldown(productId, unit, row?.productName)
              } : undefined}
            />
          </div>
        </div>
      ) : null}

      {tab === "product-performance" ? <SideBySideWorkspace filters={filters} /> : null}

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
