"use client"

import * as React from "react"
import { Package, Users, X } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import { useAPI } from "@/lib/hooks/use-api"
import { cn } from "@/lib/utils"
import {
  MEASURE_METRIC,
  budgetBesideWithheldReason,
  metricDefinitionForStatusSet,
  panelSegmentation,
  panelsForFocus,
  type ChartTypeId,
  type DrillDownStatusSet,
  type ExecutiveDimensionId,
  type ExecutiveMetricId,
  type MatrixDimensionId,
  type MeasureId,
  type SideBySidePanel,
} from "@/lib/executive-analytics"
import { retainAvailable } from "@/lib/executive-entity-selection"
import { isPanelSnapshotReady, type SideBySidePanelSnapshot } from "@/lib/executive-side-by-side-export"
import { ChartCard } from "./chart-kit"
import {
  ComparisonChart,
  ComparisonTable,
  SeriesTable,
  type ComparisonRow,
  type DrillTarget,
  type EntitySeries,
} from "./comparison-charts"
import { DrillDownPanel } from "./drill-down-panel"
import { EntityPicker, type EntityOption } from "./entity-picker"
import { groupOptionsFromBranches, toQuery, type ExecutiveFilterState } from "./executive-filters"
import { MatrixChart, MatrixTable, type MatrixResponse } from "./matrix-chart"
import { MeasureToggle } from "./measure-toggle"
import { SideBySideExportButton } from "./side-by-side-export-button"

/**
 * Product Performance — one product, every angle, on one screen.
 *
 * Reached as the `product-performance` tab of Graphical Reports, and linked
 * from the sidebar under that name.
 *
 * The Explore workbench answers one question at a time, which is the right
 * shape for an open-ended investigation and the wrong shape for the question
 * people actually arrive with: *who* used this, at *which* branch, and *when*.
 * Answering that in the workbench means building the same comparison three
 * times and remembering the first two.
 *
 * So this screen fixes the subject — a product, or a few — and varies the
 * dimension instead. Every ranking and trend panel is the *existing*
 * comparison endpoint with a different `dimension`; the one grid — requester
 * against product, uncombined, which "By product" becomes once people are
 * compared — is the `/matrix` endpoint under the same registry and the same
 * scope, so there is no new authorization surface behind any of it: the same
 * whitelist decides what may be asked, and the same fence decides which rows
 * may answer.
 *
 * Products are also a dimension here, not only the subject: with no focus, or
 * with several products ticked, the product panels rank them against each
 * other. With one product ticked, "By product" stays visible with that
 * product's total while the broader product views give way to day-by-day.
 *
 * With several requesters picked to compare, "By product" becomes that grid:
 * one cluster per product, one column per person inside it, one figure per
 * pair and never combined, so "who consumed how much of this product" is read
 * across a cluster. The registry decides which panel does this (`segmentBy`),
 * and below two people the panel draws its plain ranking.
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
  /** True when every row carries `totalBudgetCents` beside its figure, because `budget=1` was honoured. */
  budgetBeside?: boolean
  quantityUnit: { selected: string | null; conflict: boolean; available: string[] }
  blocked?: { reason: string; message: string }
  error?: string
}

/** Rank panels show more entities than a trend can carry legible lines for. */
const RANK_PANEL_ROWS = 12
const SERIES_PANEL_ROWS = 6

function productPerformanceStatusSet(metric: ExecutiveMetricId): DrillDownStatusSet {
  return metric === "spend" ? "consumed" : "revenue"
}

export function SideBySideWorkspace({ filters }: Readonly<{ filters: ExecutiveFilterState }>) {
  const [measure, setMeasure] = React.useState<MeasureId>("amount")
  const [focusProducts, setFocusProducts] = React.useState<string[]>([])
  /**
   * The requesters ticked in the picker, before the current option list has had
   * its say. Everything downstream reads `compareUsers` below, never this.
   */
  const [pickedUsers, setPickedUsers] = React.useState<string[]>([])
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
  // Amount is the budget-facing Consumed metric. Quantity keeps
  // its established fulfilled/approved order population and vocabulary.
  const statusSet = productPerformanceStatusSet(metric)
  const metricDefinition = metricDefinitionForStatusSet(metric, statusSet)

  /**
   * What each panel currently holds, for the Excel download.
   *
   * The workbook is built from these rather than from a request of its own, so
   * it can only ever contain what the screen shows. A panel that leaves the
   * grid (category and product-over-time under a single focus) withdraws its
   * entry.
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

  // Both pickers list only what is inside the caller's fence, and neither
  // narrows itself — a list that hid everything already picked could never be
  // changed.
  //
  // The requester list is resolved first because the requester selection is
  // read back through it, and the product list is asked for under that
  // selection.
  const { data: userData, isLoading: usersLoading } = useAPI<{ options: EntityOption[] }>(
    `/api/v1/analytics/executive/options?${toQuery(
      { ...filters, productIds: focusProducts },
      { dimension: "user", statuses: statusSet },
    )}`,
  )

  const userOptions = userData?.options ?? []

  /**
   * The requesters actually being compared: the ticked ones the current list
   * still offers.
   *
   * Selecting a branch re-asks the options endpoint, which answers with the
   * people who ordered *there*. Someone ticked at the branch before it would
   * otherwise stay ticked and narrow all seven panels to a person with nothing
   * in scope — seven empty charts under a trigger naming a list that no longer
   * contains them. The rule is pure and lives in `lib/executive-entity-selection.ts`.
   *
   * Only once an answer is in hand: while the request is in flight, or after it
   * failed, `userData` is absent and the selection is left exactly as picked
   * rather than dropped against an empty list.
   */
  const compareUsers = userData ? retainAvailable(pickedUsers, userOptions) : pickedUsers

  /*
   * A drop is written back to the picker's own state, so the narrowing is what
   * the reader ticked from here on and returning to the earlier branch does not
   * quietly bring the old comparison back. `retainAvailable` hands back the
   * same array when nothing was dropped, so this settles in one pass.
   */
  React.useEffect(() => {
    if (compareUsers !== pickedUsers) setPickedUsers(compareUsers)
  }, [compareUsers, pickedUsers])

  const { data: productData, isLoading: productsLoading } = useAPI<{ options: EntityOption[] }>(
    `/api/v1/analytics/executive/options?${toQuery(
      { ...filters, userIds: compareUsers },
      { dimension: "product", statuses: statusSet },
    )}`,
  )

  const productOptions = productData?.options ?? []

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

  // Category is named only while its panel is on screen. "By product" remains
  // visible for one focused product, while its one-category view is withheld.
  const comparedAcross = panels.some((panel) => panel.dimension === "category")
    ? "products, categories, requesters, branches and months"
    : "products, requesters, branches and months"

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
            onChange={setPickedUsers}
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
            onClick={() => { setFocusProducts([]); setPickedUsers([]); setDrillTarget(null) }}
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
              metricLabel: metricDefinition.label,
              metricFormula: metricDefinition.formula,
              ...filterNames,
              products: focusLabels,
              requesters: compareUsers.map(
                (key) => userOptions.find((option) => option.key === key)?.label ?? "selected requester",
              ),
              unit: null,
            }}
          />
        </div>
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        <strong className="text-slate-700 dark:text-slate-200">{subject}</strong>, measured by{" "}
        {metricDefinition.label.toLowerCase()}, compared across {comparedAcross} at once. Select
        any bar, column or point to open the order lines behind it.
        {focusProducts.length === 1 ? " Day-by-day consumption is shown below." : ""}
        {focusProducts.length > 1 ? " Choose a single product to see day-by-day consumption." : ""}
      </p>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {orderedPanels.map((panel) => {
          // A ranked panel split by the people picked to compare is served by
          // `/matrix` as a grid, one column per person inside each cluster.
          const gridRows = panelSegmentation(panel, compareUsers.length)
          return gridRows ? (
            <MatrixPanel
              key={panel.id}
              panel={panel}
              rows={gridRows}
              filters={scopedFilters}
              metric={metric}
              expanded={expanded.includes(panel.id)}
              onToggleExpanded={(next) => toggleExpanded(panel.id, next)}
              onDrillDown={setDrillTarget}
              onSnapshot={reportSnapshot}
            />
          ) : (
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
          )
        })}
      </div>

      {drillTarget ? (
        <DrillDownPanel
          target={drillTarget}
          filters={scopedFilters}
          metric={metric}
          statuses={statusSet}
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

type NamedItems = { items?: Array<{ id: number | string; name: string; groupId?: number | null; groupName?: string | null }> }

/**
 * The names behind the ids in the shared filter bar, for the workbook's cover
 * sheet.
 *
 * Each list is requested only while its filter is set, and at the same URL the
 * filter control itself uses, so it is answered from the SWR cache rather than
 * by another request. Group names come from the branch rows, exactly as the
 * group filter's own options do. An id whose name is not (yet) known is written
 * as `#id` rather than dropped — the reader should see that a filter was set
 * even if the label had not arrived.
 */
function useFilterNames(filters: ExecutiveFilterState): {
  organizations: string[]; groups: string[]; branches: string[]; categories: string[]
} {
  const branchQuery = new URLSearchParams()
  if (filters.organizationIds.length > 0) branchQuery.set("organizationId", filters.organizationIds.join(","))
  const branchQueryString = branchQuery.toString()
  const branchesUrl = `/api/v1/branches${branchQueryString ? `?${branchQueryString}` : ""}`
  const wantsBranchRows = filters.branchIds.length > 0 || filters.groupIds.length > 0

  const { data: organizations } = useAPI<NamedItems>(filters.organizationIds.length > 0 ? "/api/v1/organizations" : null)
  const { data: branches } = useAPI<NamedItems>(wantsBranchRows ? branchesUrl : null)
  const { data: categories } = useAPI<NamedItems>(filters.categoryIds.length > 0 ? "/api/v1/categories" : null)

  const resolve = (ids: string[], list: NamedItems | undefined) =>
    ids.map((id) => list?.items?.find((item) => String(item.id) === id)?.name ?? `#${id}`)
  const groupNames = groupOptionsFromBranches(branches?.items ?? [])

  return {
    organizations: resolve(filters.organizationIds, organizations),
    groups: filters.groupIds.map((id) => groupNames.find((group) => group.id === id)?.label ?? `#${id}`),
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
  const statusSet = productPerformanceStatusSet(metric)
  const panelMetric = metricDefinitionForStatusSet(metric, statusSet)

  // A requester panel honours the people picked to compare; every other
  // dimension ranks whatever is in scope.
  const keys = panel.dimension === "user" ? compareUsers.join(",") : ""

  // A budget-bearing panel asks for the Total Budget beside each column only
  // while the rule allows it — money, no product or requester narrowing — and
  // otherwise tells the reader why the budget is not there. The server applies
  // the same rule, so the panel never asks for what it would be refused.
  const budgetWithheld = panel.budgetBeside
    ? budgetBesideWithheldReason(panel.dimension, metric, {
      lineScoped: (filters.productIds?.length ?? 0) > 0 || filters.categoryIds.length > 0,
      userScoped: (filters.userIds?.length ?? 0) > 0,
    })
    : null
  const askBudget = Boolean(panel.budgetBeside) && budgetWithheld === null

  const url = `/api/v1/analytics/executive/compare?${toQuery(filters, {
    dimension: panel.dimension,
    metric,
    chart: panel.chart,
    keys,
    limit: String(limit),
    budget: askBudget ? "1" : "",
    statuses: statusSet,
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
      formula={data?.formula ?? panelMetric.formula}
      loading={isLoading}
      error={requestError}
      empty={data?.blocked?.message ?? (isEmpty ? "Nothing in the selected period under these filters." : null)}
      className={fullWidth ? "xl:col-span-2" : undefined}
      toolbar={expanded === null
        ? undefined
        : <FullWidthToggle id={expandId} title={panel.title} checked={expanded} onChange={onToggleExpanded} />}
      // Every panel has a table, not only the trends: "graph + table" is the
      // requirement, and the ranked panels are the ones doing the comparing.
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
        : (
          <ComparisonTable
            rows={rows}
            format={data?.format ?? "currency"}
            metricLabel={data?.label ?? panelMetric.label}
            dimensionLabel={panelDimensionLabel(panel.dimension)}
            concentrationEligible={Boolean(data?.concentrationEligible)}
            budgetBeside={Boolean(data?.budgetBeside)}
            dimension={panel.dimension}
            onDrillDown={onDrillDown}
          />
        )}
    >
      <ComparisonChart
        chart={data?.chart ?? panel.chart}
        rows={rows}
        series={series}
        periods={data?.periods ?? []}
        format={data?.format ?? "currency"}
        metricLabel={data?.label ?? panelMetric.label}
        dimensionLabel={panelDimensionLabel(panel.dimension)}
        unit={data?.quantityUnit.selected ?? null}
        concentrationEligible={Boolean(data?.concentrationEligible)}
        budgetBeside={Boolean(data?.budgetBeside)}
        colorful={panel.colorful}
        dualValueLabels={panel.dualValueLabels}
        fullWidth={fullWidth}
        dimension={panel.dimension}
        onDrillDown={onDrillDown}
      />
      {data?.quantityUnit.selected ? (
        <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          Measured in <strong>{data.quantityUnit.selected}</strong> only. Other units in this period are excluded rather
          than added to it.
        </p>
      ) : null}
      {budgetWithheld && !isEmpty ? (
        <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{budgetWithheld}</p>
      ) : null}
    </ChartCard>
  )
}

/** The "Full width" toggle every widenable panel carries in its toolbar. */
function FullWidthToggle({ id, title, checked, onChange }: Readonly<{
  id: string
  title: string
  checked: boolean
  onChange: (next: boolean) => void
}>) {
  return (
    <label
      htmlFor={id}
      className="mr-1 flex cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(state) => onChange(state === true)}
        aria-label={`Show ${title} at full width`}
      />
      Full width
    </label>
  )
}

/** How many entities the grid asks for on each axis: the same cap as a ranked panel. */
const MATRIX_PANEL_ENTITIES = 12

/**
 * A ranked panel worn as a grid: the columns are the panel's own dimension,
 * the rows the people picked to compare, one figure per pair.
 *
 * It reads the same shared filters as every other panel — the focused
 * products as `productIds`, the compared people as `userIds` — so its axes
 * are exactly the entities the ranking panels show, and its margins are their
 * bars. What it adds is the cells between them, which no ranking can give.
 * Its table and its sheet are the grid as drawn: one row per person, one
 * column per product, the person's total last.
 */
function MatrixPanel({ panel, rows, filters, metric, expanded, onToggleExpanded, onDrillDown, onSnapshot }: Readonly<{
  panel: SideBySidePanel
  rows: MatrixDimensionId
  filters: ExecutiveFilterState
  metric: ExecutiveMetricId
  expanded: boolean
  onToggleExpanded: (next: boolean) => void
  onDrillDown: (target: DrillTarget) => void
  onSnapshot: (panelId: string, snapshot: SideBySidePanelSnapshot | null) => void
}>) {
  const statusSet = productPerformanceStatusSet(metric)
  const panelMetric = metricDefinitionForStatusSet(metric, statusSet)
  const url = `/api/v1/analytics/executive/matrix?${toQuery(filters, {
    rows,
    columns: panel.dimension,
    metric,
    limit: String(MATRIX_PANEL_ENTITIES),
    statuses: statusSet,
  })}`

  const { data, error, isLoading } = useAPI<MatrixResponse>(url)

  const requestError = error ? "This comparison could not be loaded." : data?.error ?? null
  const isEmpty = !data || data.rows.length === 0 || data.columns.length === 0

  React.useEffect(() => {
    onSnapshot(panel.id, {
      response: data ? { ...data, mode: "matrix" } : null,
      loading: isLoading,
      error: requestError,
    })
  }, [panel.id, data, isLoading, requestError, onSnapshot])
  React.useEffect(() => () => onSnapshot(panel.id, null), [panel.id, onSnapshot])

  // An axis that filled its cap may have left entities out; say so, rather
  // than let a reader take twelve for everyone.
  const truncated = Boolean(data && !isEmpty
    && (data.columns.length >= data.limits.columns || data.rows.length >= data.limits.rows))
  const columnNoun = `${panelDimensionLabel(panel.dimension).toLowerCase()}s`
  const rowNoun = `${panelDimensionLabel(rows).toLowerCase()}s`

  return (
    <ChartCard
      title={panel.title}
      question={panel.question}
      formula={data?.formula ?? panelMetric.formula}
      loading={isLoading}
      error={requestError}
      empty={data?.blocked?.message ?? (isEmpty ? "Nothing in the selected period under these filters." : null)}
      className={expanded ? "xl:col-span-2" : undefined}
      toolbar={<FullWidthToggle id={`expand-${panel.id}`} title={panel.title} checked={expanded} onChange={onToggleExpanded} />}
      table={data ? <MatrixTable response={data} onDrillDown={onDrillDown} /> : null}
    >
      {data ? <MatrixChart response={data} onDrillDown={onDrillDown} fullWidth={expanded} /> : null}
      {data?.quantityUnit.selected ? (
        <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          Measured in <strong>{data.quantityUnit.selected}</strong> only. Other units in this period are excluded rather
          than added to it.
        </p>
      ) : null}
      {truncated ? (
        <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
          Showing the top {MATRIX_PANEL_ENTITIES} on each axis. Choose specific {columnNoun} or {rowNoun} above to see others.
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
