"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  CONSUMPTION_TREND_DEFAULT_SERIES,
  CONSUMPTION_TREND_MAX_SERIES,
  OTHER_SERIES_ID,
  type ConsumptionTrend,
  type ConsumptionTrendSeries,
} from "@/lib/product-consumption-trend"
import { cn } from "@/lib/utils"
import {
  Activity,
  Filter,
  History,
  Layers,
  LayoutGrid,
  LineChart as LineChartIcon,
  Loader2,
  RefreshCw,
  Table as TableIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { useEffect, useMemo, useState } from "react"
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import useSWR from "swr"

import { BranchFilter } from "@/components/reports/branch-filter"
import { GroupFilter } from "@/components/reports/group-filter"
import { MultiSelectFilter } from "@/components/reports/multi-select-filter"
import { ProductFilter } from "@/components/reports/product-filter"

const fetcher = (url: string) => fetch(url).then((response) => response.json())

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

/**
 * Eight categorical hues, in a fixed order, stepped once for each surface.
 *
 * The order is the colour-blindness safety mechanism, not decoration: adjacent
 * slots were chosen to clear a CVD separation of ΔE 8 and a normal-vision
 * separation of ΔE 15 against each other, in both modes, on the light surface
 * (`#ffffff`) and the dark card surface (`#0f172a`). Do not reorder, extend or
 * substitute a hue without re-validating the whole set — three of the light
 * steps sit under 3:1 against white, which is why this card always ships the
 * table view alongside the chart.
 *
 * The page's own `CHART_COLORS` are an indigo→violet ramp. They are correct for
 * a single-series bar chart and wrong here: five lines a hue apart is exactly
 * the case a one-hue ramp cannot serve.
 */
const SERIES_PALETTE = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
} as const

/** Never a categorical slot: "Other" is a remainder, not an entity. */
const OTHER_COLOR = { light: "#94a3b8", dark: "#64748b" } as const

/**
 * A colour per product, keyed on the product's own id rather than on its rank.
 *
 * Ranking the palette would repaint every surviving line the moment a filter
 * changed the top five — the reader's "the blue one" would silently become a
 * different product. Each product seeds at `id % slots` and probes forward for
 * the first free one, resolved in ascending id order so the result never
 * depends on rank.
 *
 * The guarantee is exact in one direction and best-effort in the other: no two
 * lines on screen ever share a colour, and a product keeps its colour across a
 * filter change unless a product that seeds into the same slot joins or
 * leaves. No assignment can promise more than that with eight slots and a
 * larger catalogue, which is why the legend and the tooltip — not the colour —
 * are what actually name a line.
 */
export function assignSeriesColors(
  series: Pick<ConsumptionTrendSeries, "productId">[],
  palette: readonly string[],
): Record<number, string> {
  const assigned: Record<number, string> = {}
  const taken = new Set<number>()

  const byIdentity = series
    .filter((entry) => entry.productId !== OTHER_SERIES_ID)
    .map((entry) => entry.productId)
    .sort((left, right) => left - right)

  for (const productId of byIdentity) {
    const seed = Math.abs(productId) % palette.length
    let slot = seed
    for (let probe = 0; probe < palette.length && taken.has(slot); probe += 1) {
      slot = (seed + probe + 1) % palette.length
    }
    taken.add(slot)
    assigned[productId] = palette[slot]
  }
  return assigned
}

/**
 * The request the card makes, built from what the reader picked.
 *
 * A branch-scoped role sends its own branch and nothing else. That is not the
 * control — the route pins it server-side whatever arrives — but a request that
 * says what it means is easier to read in a log than one that relies on being
 * overridden.
 *
 * "All twelve months" is sent as no `months` at all, which is what lets the
 * server fall back to the date range or to the months the data covers.
 */
export function buildTrendQuery({
  organizationId,
  isBranchScoped,
  pinnedBranchId,
  branchIds,
  groupIds,
  months,
  years,
  productIds,
  categoryIds,
  seriesCount,
}: {
  organizationId: number | string | null
  isBranchScoped: boolean
  pinnedBranchId: string
  branchIds: string[]
  groupIds: string[]
  months: number[]
  years: number[]
  productIds: string[]
  categoryIds: string[]
  seriesCount: number
}): string {
  const params = new URLSearchParams()
  if (organizationId) params.set("organizationId", String(organizationId))

  if (isBranchScoped) {
    if (pinnedBranchId) params.set("branchIds", pinnedBranchId)
  } else {
    if (branchIds.length > 0) params.set("branchIds", branchIds.join(","))
    if (groupIds.length > 0) params.set("groupIds", groupIds.join(","))
  }

  if (months.length > 0 && months.length < 12) params.set("months", months.join(","))
  if (years.length > 0) params.set("years", years.join(","))
  if (productIds.length > 0) params.set("productIds", productIds.join(","))
  if (categoryIds.length > 0) params.set("categoryIds", categoryIds.join(","))
  params.set("limit", String(seriesCount))
  return params.toString()
}

type ConsumptionChartProps = {
  role: string | undefined
  organizationId: number | string | null
  /** The branch the global selector is on; the card starts from it. */
  contextBranchIds: string[]
  /** The branch a branch-scoped role is pinned to, from the session. */
  sessionBranchId?: string | number | null
  availableYears: number[]
  defaultYears: number[]
}

type ChartRow = Record<string, string | number>

function ConsumptionTooltip({
  active,
  payload,
  label,
  colors,
}: Readonly<{
  active?: boolean
  payload?: { dataKey?: string | number; name?: string; value?: number; color?: string }[]
  label?: string
  colors: Record<string, string>
}>) {
  if (!active || !payload?.length) return null

  const ordered = [...payload].sort((left, right) => (right.value ?? 0) - (left.value ?? 0))
  const total = ordered.reduce((sum, entry) => sum + (entry.value ?? 0), 0)

  return (
    <div className="min-w-[230px] rounded-xl border border-slate-200 bg-white p-3 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
      <p className="mb-2 text-sm font-bold text-slate-900 dark:text-white">{label}</p>
      <div className="space-y-1.5">
        {ordered.map((entry) => (
          <div key={String(entry.dataKey)} className="flex items-center justify-between gap-4 text-xs">
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: colors[String(entry.dataKey)] || entry.color }}
              />
              <span className="truncate text-slate-500 dark:text-slate-400">{entry.name}</span>
            </span>
            <span className="font-bold tabular-nums text-slate-900 dark:text-slate-100">
              {(entry.value ?? 0).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between border-t border-slate-100 pt-1.5 text-xs dark:border-slate-800">
        <span className="text-slate-500">Shown total</span>
        <span className="font-bold tabular-nums text-slate-900 dark:text-slate-100">{total.toLocaleString()}</span>
      </div>
    </div>
  )
}

/**
 * Monthly consumption by product.
 *
 * Quantity consumed — fulfilled units net of approved refunds — for each of the
 * most-consumed products, month by month. Deliberately the same measure and the
 * same month buckets as the product report it sits inside, so a reader can add
 * a row up and find the figure in the table below.
 *
 * The card owns its own filters, as the bar chart above it does, because the
 * two answer different questions and a reader narrows them independently.
 */
export function MonthlyConsumptionChart({
  role,
  organizationId,
  contextBranchIds,
  sessionBranchId,
  availableYears,
  defaultYears,
}: Readonly<ConsumptionChartProps>) {
  const { theme } = useTheme()
  const isDark = theme === "dark"
  const palette = isDark ? SERIES_PALETTE.dark : SERIES_PALETTE.light
  const otherColor = isDark ? OTHER_COLOR.dark : OTHER_COLOR.light
  const gridStroke = isDark ? "#334155" : "#e2e8f0"
  const axisTick = isDark ? "#94a3b8" : "#64748b"
  const surface = isDark ? "#0f172a" : "#ffffff"

  const isBranchScoped = role === "BRANCH_ADMIN"

  const [view, setView] = useState<"chart" | "table">("chart")
  const [months, setMonths] = useState<number[]>([...ALL_MONTHS])
  const [years, setYears] = useState<number[]>(defaultYears)
  const [branchIds, setBranchIds] = useState<string[]>([])
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [productIds, setProductIds] = useState<string[]>([])
  const [categoryIds, setCategoryIds] = useState<string[]>([])
  const [seriesCount, setSeriesCount] = useState<number>(CONSUMPTION_TREND_DEFAULT_SERIES)

  useEffect(() => {
    setYears((current) => (current.length === 0 ? defaultYears : current))
  }, [defaultYears])

  // The card follows the global organization the way the rest of the screen
  // does: changing tenant clears every narrower selection, because none of them
  // can mean anything in the new one.
  useEffect(() => {
    setBranchIds([])
    setGroupIds([])
    setProductIds([])
    setCategoryIds([])
  }, [organizationId])

  useEffect(() => {
    if (contextBranchIds.length > 0) setBranchIds([...contextBranchIds])
  }, [contextBranchIds])

  useEffect(() => {
    setProductIds([])
    setBranchIds((current) => (groupIds.length > 0 ? [] : current))
    // Picking groups drops a branch chosen outside them; the server would
    // intersect it to nothing anyway.
  }, [groupIds])

  const { data: categoryData } = useSWR<{ items?: { id: number; name: string }[] }>(
    "/api/v1/categories?limit=100",
    fetcher,
    { revalidateOnFocus: false },
  )
  const categoryItems = (categoryData?.items || []).map((category) => ({
    id: String(category.id),
    label: category.name,
  }))

  const query = useMemo(() => buildTrendQuery({
    organizationId,
    isBranchScoped,
    pinnedBranchId: contextBranchIds[0] || (sessionBranchId ? String(sessionBranchId) : ""),
    branchIds,
    groupIds,
    months,
    years,
    productIds,
    categoryIds,
    seriesCount,
  }), [
    organizationId, isBranchScoped, contextBranchIds, sessionBranchId,
    branchIds, groupIds, months, years, productIds, categoryIds, seriesCount,
  ])

  const { data, isLoading, error, mutate } = useSWR<ConsumptionTrend & { error?: string }>(
    `/api/v1/analytics/products/consumption-trend?${query}`,
    fetcher,
    { keepPreviousData: true, revalidateOnFocus: false },
  )

  // Stable identities: a fresh `[]` on every render would defeat the memos below.
  const series = useMemo(() => data?.series ?? [], [data?.series])
  const axisMonths = useMemo(() => data?.months ?? [], [data?.months])

  const colorByKey = useMemo(() => {
    const assigned = assignSeriesColors(series, palette)
    const byKey: Record<string, string> = {}
    for (const entry of series) {
      byKey[`p${entry.productId}`] = entry.productId === OTHER_SERIES_ID
        ? otherColor
        : assigned[entry.productId]
    }
    return byKey
  }, [series, palette, otherColor])

  const chartRows = useMemo<ChartRow[]>(() => axisMonths.map((month, index) => {
    const row: ChartRow = { month: month.month, label: month.label }
    for (const entry of series) {
      row[`p${entry.productId}`] = entry.points[index]?.consumed ?? 0
    }
    return row
  }), [axisMonths, series])

  const hasData = series.length > 0 && axisMonths.length > 0

  const resetFilters = () => {
    setMonths([...ALL_MONTHS])
    setYears(defaultYears)
    setBranchIds(contextBranchIds.length > 0 ? [...contextBranchIds] : [])
    setGroupIds([])
    setProductIds([])
    setCategoryIds([])
    setSeriesCount(CONSUMPTION_TREND_DEFAULT_SERIES)
    void mutate()
  }

  return (
    <Card className="overflow-hidden rounded-[2rem] border border-slate-200/80 bg-white/95 shadow-2xl backdrop-blur-3xl transition-all duration-700 hover:border-indigo-400/40 hover:shadow-indigo-500/10 dark:border-slate-800 dark:bg-slate-900/95">
      <CardHeader className="space-y-4 border-b border-slate-100/80 bg-gradient-to-r from-slate-50/50 via-white/50 to-indigo-50/20 pb-4 dark:border-slate-800/50 dark:from-slate-950/20 dark:via-slate-900/80 dark:to-indigo-950/10">
        <div className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2.5 text-sm font-bold uppercase tracking-tight text-slate-800 dark:text-slate-200">
              <div className="rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 p-1.5 text-white shadow-lg shadow-emerald-500/20">
                <Activity className="h-3.5 w-3.5" />
              </div>
              Monthly Product Consumption
            </CardTitle>
            <p className="mt-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              Quantity consumed per month — fulfilled units net of approved refunds — for the
              top {seriesCount} products in the selection.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <div className="flex rounded-full border border-slate-200 p-0.5 dark:border-slate-800">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setView("chart")}
                aria-pressed={view === "chart"}
                className={cn(
                  "h-6 gap-1 rounded-full px-2.5 text-[10px] font-bold",
                  view === "chart" && "bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300",
                )}
              >
                <LineChartIcon className="h-3 w-3" /> Chart
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setView("table")}
                aria-pressed={view === "table"}
                className={cn(
                  "h-6 gap-1 rounded-full px-2.5 text-[10px] font-bold",
                  view === "table" && "bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300",
                )}
              >
                <TableIcon className="h-3 w-3" /> Table
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              className="h-7 gap-1 rounded-full px-3 text-[10px] font-bold text-rose-500 transition-all duration-200 hover:scale-105 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30"
              aria-label="Reset consumption trend filters"
              title="Reset consumption trend filters"
            >
              <RefreshCw className={cn("h-3 w-3", isLoading && "animate-spin")} /> Reset
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <MultiSelectFilter
            title="Months"
            items={MONTH_NAMES.map((name, index) => ({ id: index + 1, label: name }))}
            selectedIds={months}
            onChange={(ids) => setMonths(ids.toSorted((a: number, b: number) => a - b))}
            icon={<Filter className="h-3.5 w-3.5 text-emerald-500" />}
            placeholder="Months"
            showSearch={false}
          />
          <MultiSelectFilter
            title="Years"
            items={availableYears.map((year) => ({ id: year, label: String(year) }))}
            selectedIds={years}
            onChange={(ids) => setYears(ids.toSorted((a: number, b: number) => b - a))}
            icon={<History className="h-3.5 w-3.5 text-indigo-500" />}
            placeholder="Years"
            showSearch={false}
          />
          <MultiSelectFilter
            title="Categories"
            items={categoryItems}
            selectedIds={categoryIds}
            onChange={(ids) => setCategoryIds(ids.map(String))}
            icon={<Layers className="h-3.5 w-3.5 text-amber-500" />}
            placeholder="Categories"
          />
          {!isBranchScoped && (
            <>
              {/*
                The department tier, called by its name in this product: a
                group. The rest of the application labels it "Groups" and so
                does this, rather than introducing a second word for one thing.
              */}
              <GroupFilter
                selectedIds={groupIds}
                onChange={setGroupIds}
                organizationId={organizationId || undefined}
                disabled={branchIds.length > 0}
                placeholder="Groups"
              />
              <BranchFilter
                selectedIds={branchIds}
                onChange={setBranchIds}
                organizationId={organizationId || undefined}
                groupIds={groupIds}
                placeholder="Branches"
              />
            </>
          )}
          <ProductFilter
            selectedIds={productIds}
            onChange={setProductIds}
            organizationId={organizationId || undefined}
            groupIds={groupIds}
            branchIds={branchIds}
            placeholder="Products"
          />
          <MultiSelectFilter
            title="Lines"
            items={Array.from({ length: CONSUMPTION_TREND_MAX_SERIES }, (_, index) => ({
              id: index + 1,
              label: `Top ${index + 1}`,
            }))}
            selectedIds={[seriesCount]}
            onChange={(ids) => setSeriesCount(Number(ids[0]) || CONSUMPTION_TREND_DEFAULT_SERIES)}
            icon={<LayoutGrid className="h-3.5 w-3.5 text-violet-500" />}
            placeholder="Lines"
            showSearch={false}
            maxSelect={1}
          />
        </div>

        {data?.hasOther && (
          <p className="ml-1 text-[10px] font-semibold text-slate-400">
            {data.productsInWindow - seriesCount} further product(s) folded into “Other products”.
          </p>
        )}
      </CardHeader>

      <CardContent className="pb-6 pl-0 pr-6 pt-6">
        {(() => {
          if (isLoading && !data) {
            return (
              <div className="flex h-[340px] items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
              </div>
            )
          }

          if (error || data?.error) {
            return (
              <div className="flex h-[340px] items-center justify-center px-6 text-center text-xs font-semibold text-rose-500">
                {data?.error || "Consumption trend is unavailable right now."}
              </div>
            )
          }

          if (!hasData) {
            return (
              <div className="flex h-[340px] flex-col items-center justify-center gap-2 px-6 text-center">
                <Activity className="h-6 w-6 text-slate-300 dark:text-slate-700" />
                <p className="text-xs font-bold text-slate-500">No consumption in this selection</p>
                <p className="text-[11px] text-slate-400">
                  Widen the months, years, branches or products above.
                </p>
              </div>
            )
          }

          if (view === "table") {
            return (
              <div className="ml-4 max-h-[340px] overflow-auto rounded-xl border border-slate-200 dark:border-slate-800">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[10px] uppercase">Product</TableHead>
                      {axisMonths.map((month) => (
                        <TableHead key={month.month} className="text-right text-[10px] uppercase">
                          {month.label}
                        </TableHead>
                      ))}
                      <TableHead className="text-right text-[10px] uppercase">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {series.map((entry) => (
                      <TableRow key={entry.productId}>
                        <TableCell className="text-xs font-semibold">
                          <span className="flex items-center gap-2">
                            <span
                              aria-hidden
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{ backgroundColor: colorByKey[`p${entry.productId}`] }}
                            />
                            {entry.productName}
                            {entry.productCode && (
                              <Badge variant="secondary" className="font-mono text-[9px]">
                                {entry.productCode}
                              </Badge>
                            )}
                          </span>
                        </TableCell>
                        {entry.points.map((point) => (
                          <TableCell key={point.month} className="text-right text-xs tabular-nums">
                            {point.consumed.toLocaleString()}
                          </TableCell>
                        ))}
                        <TableCell className="text-right text-xs font-bold tabular-nums">
                          {entry.totalConsumed.toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )
          }

          return (
            <div className="ml-4 w-full">
              {/*
                The y-axis unit, named above the plot rather than rotated
                inside a 56px gutter where it would sit on top of the ticks.
              */}
              <p className="mb-1 pl-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                Qty consumed
              </p>
              <div className="h-[320px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartRows} margin={{ top: 16, right: 24, left: 12, bottom: 12 }}>
                  <CartesianGrid stroke={gridStroke} strokeWidth={1} vertical={false} />
                  <XAxis
                    dataKey="label"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: axisTick, fontSize: 11, fontWeight: 600 }}
                    dy={8}
                    interval="preserveStartEnd"
                    minTickGap={12}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    width={56}
                    tick={{ fill: axisTick, fontSize: 10 }}
                    tickFormatter={(value: number) => (
                      value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K` : String(value)
                    )}
                  />
                  <Tooltip
                    content={<ConsumptionTooltip colors={colorByKey} />}
                    cursor={{ stroke: gridStroke, strokeWidth: 1 }}
                  />
                  {/*
                    Always present: with two or more lines, identity may never
                    rest on colour alone. Long catalogue names are clipped so a
                    wrapping legend cannot push the plot off the card; the
                    tooltip carries the full name.
                  */}
                  <Legend
                    verticalAlign="top"
                    align="left"
                    iconType="plainline"
                    wrapperStyle={{ paddingBottom: 16, fontSize: 10, fontWeight: 700 }}
                    formatter={(value: string) => (
                      value.length > 28 ? `${value.slice(0, 27)}…` : value
                    )}
                  />
                  {series.map((entry) => (
                    <Line
                      key={entry.productId}
                      type="monotone"
                      dataKey={`p${entry.productId}`}
                      name={entry.productName}
                      stroke={colorByKey[`p${entry.productId}`]}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeDasharray={entry.productId === OTHER_SERIES_ID ? "4 4" : undefined}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 2, stroke: surface }}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
              </div>
            </div>
          )
        })()}
      </CardContent>
    </Card>
  )
}
