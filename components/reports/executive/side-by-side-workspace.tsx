"use client"

import * as React from "react"
import { Package, Users, X } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import { useAPI } from "@/lib/hooks/use-api"
import { cn } from "@/lib/utils"
import {
  EXECUTIVE_METRICS,
  MEASURE_METRIC,
  panelsForFocus,
  type ChartTypeId,
  type ExecutiveDimensionId,
  type ExecutiveMetricId,
  type MeasureId,
  type SideBySidePanel,
} from "@/lib/executive-analytics"
import { isPanelSnapshotReady, type SideBySidePanelSnapshot } from "@/lib/executive-side-by-side-export"
import { ChartCard } from "./chart-kit"
import {
  ComparisonChart,
  SeriesTable,
  type ComparisonRow,
  type DrillTarget,
  type EntitySeries,
} from "./comparison-charts"
import { DrillDownPanel } from "./drill-down-panel"
import { EntityPicker, type EntityOption } from "./entity-picker"
import { toQuery, type ExecutiveFilterState } from "./executive-filters"
import { MeasureToggle } from "./measure-toggle"
import { SideBySideExportButton } from "./side-by-side-export-button"

/**
 * Level 3 — one product, every angle, on one screen.
 *
 * The Explore workbench answers one question at a time, which is the right
 * shape for an open-ended investigation and the wrong shape for the question
 * people actually arrive with: *who* used this, at *which* branch, and *when*.
 * Answering that in the workbench means building the same comparison three
 * times and remembering the first two.
 *
 * So this screen fixes the subject — a product, or a few — and varies the
 * dimension instead. Every panel is the *existing* comparison endpoint with a
 * different `dimension`, so there is no new aggregation path and no new
 * authorization surface behind any of it: the same registry decides what may be
 * asked, and the same scope decides which rows may answer.
 *
 * Products are also a dimension here, not only the subject: with no focus, or
 * with several products ticked, the product panels rank them against each
 * other. Ticking one product collapses those panels into the day-by-day view,
 * where a single bar would only restate the subject line.
 *
 * Two things are shared across every panel, deliberately:
 *
 *  * **the measure** — flipping Amount ⇄ Quantity re-asks all five questions at
 *    once, which is the comparison people are really making when they flip it;
 *  * **the detail table** — whichever panel is clicked, the rows open in the
 *    same place, under the same period and the same filters.
 */

type ComparisonResponse = {
  rows: ComparisonRow[]
  series: EntitySeries[]
  periods: string[]
  format: string
  label: string
  formula: string
  mode: "rank" | "series"
  chart: ChartTypeId
  concentrationEligible: boolean
  quantityUnit: { selected: string | null; conflict: boolean; available: string[] }
  blocked?: { reason: string; message: string }
  error?: string
}

/** Rank panels show more entities than a trend can carry legible lines for. */
const RANK_PANEL_ROWS = 12
const SERIES_PANEL_ROWS = 6

export function SideBySideWorkspace({ filters }: Readonly<{ filters: ExecutiveFilterState }>) {
  const [measure, setMeasure] = React.useState<MeasureId>("amount")
  const [focusProducts, setFocusProducts] = React.useState<string[]>([])
  const [compareUsers, setCompareUsers] = React.useState<string[]>([])
  const [drillTarget, setDrillTarget] = React.useState<DrillTarget | null>(null)
  /**
   * Panels the reader has widened to the full row.
   *
   * Twelve bars in half a row are legible but cramped, and a month axis across
   * twenty months is not. Each panel carries its own "Full width" checkbox so
   * the reader decides which question deserves the room; the rest keep their
   * place in the grid rather than being pushed off screen.
   */
  const [expanded, setExpanded] = React.useState<string[]>([])
  const toggleExpanded = React.useCallback((panelId: string, next: boolean) => {
    setExpanded((current) => (
      next ? Array.from(new Set([...current, panelId])) : current.filter((id) => id !== panelId)
    ))
  }, [])

  const metric: ExecutiveMetricId = MEASURE_METRIC[measure]

  /**
   * What each panel currently holds, for the Excel download.
   *
   * The workbook is built from these rather than from a request of its own, so
   * it can only ever contain what the screen shows. A panel that leaves the
   * grid (the product panels under a single focus) withdraws its entry.
   *
   * The responses live in a ref, not in state: a panel reports on every
   * answer, and routing six responses through state would redraw every chart
   * on the screen each time one of them loaded. Only readiness — the one fact
   * the button renders from — is state, and it flips at most twice per fetch.
   */
  const snapshotsRef = React.useRef<Record<string, SideBySidePanelSnapshot>>({})
  const [panelReady, setPanelReady] = React.useState<Record<string, boolean>>({})
  const reportSnapshot = React.useCallback((panelId: string, snapshot: SideBySidePanelSnapshot | null) => {
    if (snapshot) snapshotsRef.current[panelId] = snapshot
    else delete snapshotsRef.current[panelId]

    const next = snapshot ? isPanelSnapshotReady(snapshot) : undefined
    setPanelReady((current) => {
      if (current[panelId] === next) return current
      if (next === undefined) {
        const { [panelId]: _withdrawn, ...rest } = current
        return rest
      }
      return { ...current, [panelId]: next }
    })
  }, [])
  const readSnapshots = React.useCallback(() => ({ ...snapshotsRef.current }), [])

  /**
   * The filter set every panel shares.
   *
   * Resolved once so the five panels and the detail table cannot disagree about
   * what is in scope — a table showing rows its own chart did not count is the
   * single worst failure a drill-down can have.
   */
  const scopedFilters = React.useMemo<ExecutiveFilterState>(
    () => ({ ...filters, productIds: focusProducts, userIds: compareUsers }),
    [filters, focusProducts, compareUsers],
  )

  // Both pickers list only what is inside the caller's fence, and neither
  // narrows itself — a list that hid everything already picked could never be
  // changed.
  const { data: productData, isLoading: productsLoading } = useAPI<{ options: EntityOption[] }>(
    `/api/v1/analytics/executive/options?${toQuery(
      { ...filters, userIds: compareUsers },
      { dimension: "product" },
    )}`,
  )
  const { data: userData, isLoading: usersLoading } = useAPI<{ options: EntityOption[] }>(
    `/api/v1/analytics/executive/options?${toQuery(
      { ...filters, productIds: focusProducts },
      { dimension: "user" },
    )}`,
  )

  const productOptions = productData?.options ?? []
  const userOptions = userData?.options ?? []
  const panels = panelsForFocus(focusProducts.length)
  const filterNames = useFilterNames(filters)

  /**
   * Widened panels lead the grid, in registry order among themselves.
   *
   * A two-column grid cannot widen a panel in place: the half-row before it
   * would be left empty. Bringing the widened panel to the top is also what the
   * reader asked for by ticking it — the one question they want the room for.
   */
  const orderedPanels = React.useMemo(() => {
    const rank = (panel: SideBySidePanel) => (expanded.includes(panel.id) ? 0 : 1)
    return [...panels].sort((left, right) => rank(left) - rank(right))
  }, [panels, expanded])

  const focusLabels = focusProducts.map(
    (key) => productOptions.find((option) => option.key === key)?.label ?? "selected product",
  )

  const subject = (() => {
    if (focusLabels.length === 0) return "All products"
    if (focusLabels.length <= 2) return focusLabels.join(" and ")
    return `${focusLabels.length} products`
  })()

  // Products are named among the compared dimensions only while the product
  // panels are on screen; with one product in focus they are the subject alone.
  const comparedAcross = panels.some((panel) => panel.dimension === "product")
    ? "products, requesters, branches and months"
    : "requesters, branches and months"

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3 rounded-xl border border-slate-200 bg-white/60 p-3 dark:border-slate-700 dark:bg-slate-900/40">
        <Control label="Product">
          <EntityPicker
            noun="products"
            options={productOptions}
            selected={focusProducts}
            onChange={setFocusProducts}
            loading={productsLoading}
            emptyLabel="All products"
            className="w-[260px]"
            icon={<Package className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />}
          />
        </Control>

        <Control label="Requesters to compare">
          <EntityPicker
            noun="people"
            options={userOptions}
            selected={compareUsers}
            onChange={setCompareUsers}
            loading={usersLoading}
            emptyLabel="All requesters (top ranked)"
            className="w-[260px]"
            icon={<Users className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />}
          />
        </Control>

        <Control label="Measured by">
          <MeasureToggle value={measure} onChange={setMeasure} />
        </Control>

        {focusProducts.length > 0 || compareUsers.length > 0 ? (
          <button
            type="button"
            onClick={() => { setFocusProducts([]); setCompareUsers([]); setDrillTarget(null) }}
            className="flex items-center gap-1 rounded-lg px-2 py-2 text-[11px] font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
          >
            <X className="h-3 w-3" aria-hidden />
            Clear selection
          </button>
        ) : null}

        <div className="ml-auto">
          <SideBySideExportButton
            panels={panels}
            ready={panels.length > 0 && panels.every((panel) => panelReady[panel.id] === true)}
            readSnapshots={readSnapshots}
            context={{
              startDate: filters.startDate,
              endDate: filters.endDate,
              measure,
              metricLabel: EXECUTIVE_METRICS[metric].label,
              metricFormula: EXECUTIVE_METRICS[metric].formula,
              ...filterNames,
              products: focusLabels,
              requesters: compareUsers.map(
                (key) => userOptions.find((option) => option.key === key)?.label ?? "selected requester",
              ),
              unit: filters.unit,
            }}
          />
        </div>
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        <strong className="text-slate-700 dark:text-slate-200">{subject}</strong>, measured by{" "}
        {EXECUTIVE_METRICS[metric].label.toLowerCase()}, compared across {comparedAcross} at once. Select
        any bar, column or point to open the order lines behind it.
        {focusProducts.length === 1 ? " Day-by-day consumption is shown below." : ""}
        {focusProducts.length > 1 ? " Choose a single product to see day-by-day consumption." : ""}
      </p>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {orderedPanels.map((panel) => (
          <ComparePanel
            key={panel.id}
            panel={panel}
            filters={scopedFilters}
            metric={metric}
            compareUsers={compareUsers}
            // The single-product panel is always the full row; every other
            // panel widens only when its own checkbox says so.
            expanded={panel.requiresSingleProduct ? null : expanded.includes(panel.id)}
            onToggleExpanded={(next) => toggleExpanded(panel.id, next)}
            onDrillDown={setDrillTarget}
            onSnapshot={reportSnapshot}
          />
        ))}
      </div>

      {drillTarget ? (
        <DrillDownPanel
          target={drillTarget}
          filters={scopedFilters}
          metric={metric}
          onClose={() => setDrillTarget(null)}
        />
      ) : null}
    </div>
  )
}

function Control({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </span>
      {children}
    </div>
  )
}

type NamedItems = { items?: Array<{ id: number | string; name: string }> }

/**
 * The names behind the ids in the shared filter bar, for the workbook's cover
 * sheet.
 *
 * Each list is requested only while its filter is set, and at the same URL the
 * filter control itself uses, so it is answered from the SWR cache rather than
 * by another request. An id whose name is not (yet) known is written as
 * `#id` rather than dropped — the reader should see that a filter was set even
 * if the label had not arrived.
 */
function useFilterNames(filters: ExecutiveFilterState): { organizations: string[]; branches: string[]; categories: string[] } {
  const branchQuery = new URLSearchParams()
  if (filters.organizationIds.length > 0) branchQuery.set("organizationId", filters.organizationIds.join(","))
  const branchQueryString = branchQuery.toString()
  const branchesUrl = `/api/v1/branches${branchQueryString ? `?${branchQueryString}` : ""}`

  const { data: organizations } = useAPI<NamedItems>(filters.organizationIds.length > 0 ? "/api/v1/organizations" : null)
  const { data: branches } = useAPI<NamedItems>(filters.branchIds.length > 0 ? branchesUrl : null)
  const { data: categories } = useAPI<NamedItems>(filters.categoryIds.length > 0 ? "/api/v1/categories" : null)

  const resolve = (ids: string[], list: NamedItems | undefined) =>
    ids.map((id) => list?.items?.find((item) => String(item.id) === id)?.name ?? `#${id}`)

  return {
    organizations: resolve(filters.organizationIds, organizations),
    branches: resolve(filters.branchIds, branches),
    categories: resolve(filters.categoryIds, categories),
  }
}

/**
 * One panel: one dimension, the shared subject, the shared measure.
 *
 * Each fetches independently rather than through a combined endpoint, so a
 * dimension that returns nothing — a period with no orders for one branch, say
 * — leaves the other four panels intact instead of emptying the screen.
 */
function ComparePanel({ panel, filters, metric, compareUsers, expanded, onToggleExpanded, onDrillDown, onSnapshot }: Readonly<{
  panel: SideBySidePanel
  filters: ExecutiveFilterState
  metric: ExecutiveMetricId
  compareUsers: string[]
  /** Whether the panel spans the row; `null` when it always does and offers no choice. */
  expanded: boolean | null
  onToggleExpanded: (next: boolean) => void
  onDrillDown: (target: DrillTarget) => void
  /** Reports what the panel holds, for the download; `null` when it leaves the grid. */
  onSnapshot: (panelId: string, snapshot: SideBySidePanelSnapshot | null) => void
}>) {
  const isSeries = panel.chart === "line"
  const limit = isSeries ? SERIES_PANEL_ROWS : RANK_PANEL_ROWS
  const fullWidth = expanded === null || expanded
  const expandId = `expand-${panel.id}`

  // A requester panel honours the people picked to compare; every other
  // dimension ranks whatever is in scope.
  const keys = panel.dimension === "user" ? compareUsers.join(",") : ""

  const url = `/api/v1/analytics/executive/compare?${toQuery(filters, {
    dimension: panel.dimension,
    metric,
    chart: panel.chart,
    keys,
    limit: String(limit),
  })}`

  const { data, error, isLoading } = useAPI<ComparisonResponse>(url)

  const requestError = error ? "This comparison could not be loaded." : data?.error ?? null
  const rows = data?.rows ?? []
  const series = data?.series ?? []
  const isEmpty = data?.mode === "series" ? series.length === 0 : rows.length === 0

  // The same three facts the card renders from, so the download cannot show a
  // figure the panel did not. Reporting is cheap: the parent re-renders only
  // when the panel's readiness flips, never on the report itself.
  React.useEffect(() => {
    onSnapshot(panel.id, { response: data ?? null, loading: isLoading, error: requestError })
  }, [panel.id, data, isLoading, requestError, onSnapshot])
  React.useEffect(() => () => onSnapshot(panel.id, null), [panel.id, onSnapshot])

  return (
    <ChartCard
      title={panel.title}
      question={panel.question}
      formula={data?.formula ?? EXECUTIVE_METRICS[metric].formula}
      loading={isLoading}
      error={requestError}
      empty={data?.blocked?.message ?? (isEmpty ? "Nothing in the selected period under these filters." : null)}
      className={fullWidth ? "xl:col-span-2" : undefined}
      toolbar={expanded === null
        ? undefined
        : (
          <label
            htmlFor={expandId}
            className="mr-1 flex cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <Checkbox
              id={expandId}
              checked={expanded}
              onCheckedChange={(state) => onToggleExpanded(state === true)}
              aria-label={`Show ${panel.title} at full width`}
            />
            Full width
          </label>
        )}
      table={data?.mode === "series"
        ? (
          <SeriesTable
            series={series}
            periods={data?.periods ?? []}
            format={data?.format ?? "currency"}
            onSelectEntity={(key, index) => onDrillDown({
              dimension: panel.dimension,
              key,
              label: series[index]?.label ?? key,
            })}
          />
        )
        : undefined}
    >
      <ComparisonChart
        chart={data?.chart ?? panel.chart}
        rows={rows}
        series={series}
        periods={data?.periods ?? []}
        format={data?.format ?? "currency"}
        metricLabel={data?.label ?? EXECUTIVE_METRICS[metric].label}
        dimensionLabel={panelDimensionLabel(panel.dimension)}
        unit={data?.quantityUnit.selected ?? null}
        concentrationEligible={Boolean(data?.concentrationEligible)}
        colorful={panel.colorful}
        dimension={panel.dimension}
        onDrillDown={onDrillDown}
      />
      {data?.quantityUnit.selected ? (
        <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          Measured in <strong>{data.quantityUnit.selected}</strong> only. Other units in this period are excluded rather
          than added to it.
        </p>
      ) : null}
    </ChartCard>
  )
}

const PANEL_DIMENSION_LABEL: Record<ExecutiveDimensionId, string> = {
  branch: "Branch",
  group: "Group",
  organization: "Organization",
  user: "Requester",
  category: "Category",
  product: "Product",
  month: "Month",
  day: "Day",
}

function panelDimensionLabel(dimension: ExecutiveDimensionId): string {
  return PANEL_DIMENSION_LABEL[dimension]
}
