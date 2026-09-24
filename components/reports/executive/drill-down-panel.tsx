"use client"

import * as React from "react"
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ListTree, X } from "lucide-react"

import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useAPI } from "@/lib/hooks/use-api"
import { cn } from "@/lib/utils"
import {
  DRILLDOWN_DEFAULT_ROWS,
  EXECUTIVE_METRICS,
  type DrillDownSortKey,
  type DrillDownStatusSet,
  type ExecutiveMetricId,
} from "@/lib/executive-analytics"
import { ChartMessage, countShort, money } from "./chart-kit"
import type { DrillTarget } from "./comparison-charts"
import { toQuery, type ExecutiveFilterState } from "./executive-filters"

/**
 * The rows behind a clicked bar.
 *
 * This is the other half of an interactive chart: the visual says *how much*,
 * and this says *which orders*, for exactly the bar that was clicked and under
 * exactly the filters and period the chart was drawn with. The server narrows
 * the window itself when a month or a day was clicked, so the reader never has
 * to re-state the period they were already looking at — and the totals strip
 * exists so they can check the sum against the bar they came from.
 *
 * Everything here is read-only. The endpoint behind it resolves the caller's
 * tenant from their own user row, so a table opened from a chart can only name
 * rows that chart could already have counted.
 */

type DrillDownRow = {
  lineId: number
  orderId: number
  tid: string
  createdAt: string
  status: string
  branchName: string
  requesterName: string
  productName: string
  categoryName: string
  unit: string
  quantity: number
  unitPriceCents: number
  valueCents: number
}

type DrillDownResponse = {
  dimensionLabel: string
  metricLabel: string
  period: { startDate: string; endDate: string }
  rows: DrillDownRow[]
  totals: {
    lineCount: number
    orderCount: number
    valueCents: number
    quantity: number
    quantityByUnit: Array<{ unit: string; quantity: number }>
  }
  hasMore: boolean
  error?: string
}

const COLUMNS: Array<{ id: DrillDownSortKey | null; label: string; numeric?: boolean }> = [
  { id: "date", label: "Date" },
  { id: null, label: "Order" },
  { id: "branch", label: "Branch" },
  { id: "requester", label: "Requester" },
  { id: "product", label: "Product" },
  { id: "quantity", label: "Qty", numeric: true },
  { id: "unitPrice", label: "Unit price", numeric: true },
  { id: "value", label: "Value", numeric: true },
  { id: null, label: "Status" },
]

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  day: "2-digit",
  month: "short",
  year: "numeric",
})

/** Rendered in the application timezone, the same one the buckets were built in. */
function formatDay(iso: string): string {
  if (!iso) return "—"
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date)
}

function periodLabel(period: { startDate: string; endDate: string } | undefined): string {
  if (!period) return ""
  return `${formatDay(period.startDate)} – ${formatDay(period.endDate)}`
}

/**
 * What a status set adds to the request and to the header — nothing for the
 * default, so every existing request stays byte-identical.
 */
function statusSetCopy(statuses: DrillDownStatusSet): { param: string; note: string } {
  if (statuses !== "consumed") return { param: "", note: "" }
  return { param: "consumed", note: " Orders still awaiting approval are included and marked pending." }
}

export function DrillDownPanel({ target, filters, metric, statuses = "revenue", onClose }: Readonly<{
  target: DrillTarget
  filters: ExecutiveFilterState
  metric: ExecutiveMetricId
  /**
   * Which orders to list. The charts' own rule by default; `consumed` adds
   * orders still awaiting approval, for a figure that is a budget's
   * "spent + held" rather than a Procurement Value.
   */
  statuses?: DrillDownStatusSet
  onClose: () => void
}>) {
  const [sort, setSort] = React.useState<DrillDownSortKey>("date")
  const [direction, setDirection] = React.useState<"asc" | "desc">("desc")
  const [page, setPage] = React.useState(0)

  // A different bar is a different question: paging starts over rather than
  // opening the new selection on page four of the old one. A grid cell names a
  // second entity, so that is part of the question too.
  const targetSignature = `${target.dimension}:${target.key}:${target.period ?? ""}:${JSON.stringify(target.narrow ?? {})}`
  const previousSignature = React.useRef(targetSignature)
  React.useEffect(() => {
    if (previousSignature.current === targetSignature) return
    previousSignature.current = targetSignature
    setPage(0)
  }, [targetSignature])

  /**
   * The table opens below the charts, and on a screen with six panels that is
   * well past the fold. A click on a bar therefore brings the table to the
   * reader rather than leaving them to find it — on first open and again when a
   * different bar is selected. Reduced-motion readers get an instant jump.
   */
  const cardRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const prefersReducedMotion = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    cardRef.current?.scrollIntoView?.({
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: "start",
    })
  }, [targetSignature])

  const statusSet = statusSetCopy(statuses)

  // The click's own narrowing wins over the screen's: a grid cell is one
  // product, whatever the focus picker holds.
  const url = `/api/v1/analytics/executive/drill-down?${toQuery({ ...filters, ...target.narrow }, {
    dimension: target.dimension,
    key: target.key,
    metric,
    period: target.period ?? "",
    sort,
    direction,
    limit: String(DRILLDOWN_DEFAULT_ROWS),
    offset: String(page * DRILLDOWN_DEFAULT_ROWS),
    statuses: statusSet.param,
  })}`

  const { data, error, isLoading } = useAPI<DrillDownResponse>(url)

  const requestError = error
    ? "These order lines could not be loaded. The selection may have expired — try selecting on the chart again."
    : data?.error ?? null

  const rows = data?.rows ?? []
  const totals = data?.totals

  /**
   * A budget bar has no order lines of its own.
   *
   * Utilization and remaining budget come from the ledger — an allocation, plus
   * what is committed but not yet fulfilled — so the purchases listed below are
   * only the *spent* part of that figure and will not add up to the bar. Saying
   * so is the honest option: the rows are still the useful answer to "what did
   * this branch actually buy", and silently letting the two disagree is what
   * would make the drill-down untrustworthy.
   */
  const isBudgetFigure = EXECUTIVE_METRICS[metric].grain === "budget"

  const toggleSort = (key: DrillDownSortKey) => {
    if (sort === key) {
      setDirection((current) => (current === "asc" ? "desc" : "asc"))
      return
    }
    setSort(key)
    setDirection("desc")
    setPage(0)
  }

  return (
    // The wrapper owns the scroll anchor: `Card` is a plain function component
    // on React 18 and does not forward a ref.
    <div ref={cardRef} id="executive-drill-down" className="scroll-mt-4">
    <Card className="overflow-hidden ring-1 ring-indigo-200 dark:ring-indigo-900">
      <CardHeader className="gap-1 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold leading-tight text-slate-900 dark:text-slate-100">
              <ListTree className="h-4 w-4 text-indigo-600" aria-hidden />
              {target.label}
              <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
                {data?.dimensionLabel ?? target.dimension}
              </span>
            </h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              The order lines behind this selection{data ? `, ${periodLabel(data.period)}` : ""}. The period and every
              filter are carried over from the chart.
              {statusSet.note}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
          >
            <X className="h-3 w-3" aria-hidden />
            Close
          </button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {isBudgetFigure && !requestError ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
            {EXECUTIVE_METRICS[metric].label} is a budget position, not a purchase. These are the order lines in the
            same period — the spent part of that figure. The allocation and anything committed but not yet fulfilled
            have no lines, so this total will not equal the bar.
          </p>
        ) : null}

        {totals && !requestError ? (
          <dl className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/50">
            <Total term="Orders" value={countShort(totals.orderCount)} />
            <Total term="Lines" value={countShort(totals.lineCount)} />
            <Total term="Value" value={money(totals.valueCents)} />
            <Total term="Quantity" value={countShort(totals.quantity)} />
          </dl>
        ) : null}

        {isLoading ? <Skeleton className="h-[220px] w-full rounded-lg" /> : null}
        {!isLoading && requestError ? <ChartMessage tone="error" message={requestError} /> : null}
        {!isLoading && !requestError && rows.length === 0 ? (
          <ChartMessage
            tone="empty"
            message="No order lines behind this selection, under this period and these filters."
          />
        ) : null}

        {!isLoading && !requestError && rows.length > 0 ? (
          <LineTable rows={rows} sort={sort} direction={direction} onSort={toggleSort} />
        ) : null}

        {!isLoading && !requestError ? (
          <Pager
            page={page}
            shown={rows.length}
            lineCount={totals?.lineCount}
            hasMore={Boolean(data?.hasMore)}
            onPage={setPage}
          />
        ) : null}

      </CardContent>
    </Card>
    </div>
  )
}

function Total({ term, value }: Readonly<{ term: string; value: string }>) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{term}</dt>
      <dd className="text-sm font-bold tabular-nums text-slate-900 dark:text-slate-100">{value}</dd>
    </div>
  )
}

function PageButton({ label, disabled, onClick, children }: Readonly<{
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}>) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-md border border-slate-200 p-1 transition dark:border-slate-700",
        disabled
          ? "cursor-not-allowed opacity-40"
          : "hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800",
      )}
    >
      {children}
    </button>
  )
}

/**
 * The rows themselves.
 *
 * Split out so the panel above stays a state container and this stays a pure
 * rendering of what came back — the sort header is the only interactive part,
 * and it reports up rather than deciding anything itself.
 */
function LineTable({ rows, sort, direction, onSort }: Readonly<{
  rows: DrillDownRow[]
  sort: DrillDownSortKey
  direction: "asc" | "desc"
  onSort: (key: DrillDownSortKey) => void
}>) {
  return (
    <div className="max-h-[420px] overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-800">
          <tr>
            {COLUMNS.map((column) => (
              <SortableHeader
                key={column.label}
                column={column}
                sort={sort}
                direction={direction}
                onSort={onSort}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.lineId}
              className="border-t border-slate-100 dark:border-slate-800"
            >
              <td className="whitespace-nowrap px-3 py-1.5 text-slate-600 dark:text-slate-400">
                {formatDay(row.createdAt)}
              </td>
              <td className="whitespace-nowrap px-3 py-1.5 font-medium text-slate-700 dark:text-slate-300">
                {row.tid}
              </td>
              <td className="px-3 py-1.5 text-slate-700 dark:text-slate-300">{row.branchName}</td>
              <td className="px-3 py-1.5 text-slate-700 dark:text-slate-300">{row.requesterName}</td>
              <td className="px-3 py-1.5 text-slate-700 dark:text-slate-300">
                {row.productName}
                <span className="block text-[10px] text-slate-400">{row.categoryName}</span>
              </td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700 dark:text-slate-300">
                {countShort(row.quantity)} {row.unit}
              </td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700 dark:text-slate-300">
                {money(row.unitPriceCents)}
              </td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {money(row.valueCents)}
              </td>
              <td className="whitespace-nowrap px-3 py-1.5 text-slate-600 dark:text-slate-400">{row.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SortableHeader({ column, sort, direction, onSort }: Readonly<{
  column: (typeof COLUMNS)[number]
  sort: DrillDownSortKey
  direction: "asc" | "desc"
  onSort: (key: DrillDownSortKey) => void
}>) {
  const active = Boolean(column.id) && sort === column.id
  return (
    <th
      scope="col"
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : undefined}
      className={cn(
        "whitespace-nowrap px-3 py-2 font-semibold text-slate-600 dark:text-slate-300",
        column.numeric ? "text-right" : "text-left",
      )}
    >
      {column.id ? (
        <button
          type="button"
          onClick={() => onSort(column.id as DrillDownSortKey)}
          className="inline-flex items-center gap-1 rounded hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:text-slate-100"
        >
          {column.label}
          {active ? (
            direction === "asc"
              ? <ArrowUp className="h-3 w-3" aria-hidden />
              : <ArrowDown className="h-3 w-3" aria-hidden />
          ) : null}
        </button>
      ) : (
        column.label
      )}
    </th>
  )
}

/** Shown only once there is a second page to reach. */
function Pager({ page, shown, lineCount, hasMore, onPage }: Readonly<{
  page: number
  shown: number
  lineCount?: number
  hasMore: boolean
  onPage: (next: (current: number) => number) => void
}>) {
  if (page === 0 && !hasMore) return null
  return (
    <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
      <span>
        Showing {page * DRILLDOWN_DEFAULT_ROWS + 1}–{page * DRILLDOWN_DEFAULT_ROWS + shown}
        {lineCount === undefined ? "" : ` of ${lineCount} lines`}
      </span>
      <span className="flex items-center gap-1">
        <PageButton label="Previous page" disabled={page === 0} onClick={() => onPage((current) => Math.max(0, current - 1))}>
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        </PageButton>
        <PageButton label="Next page" disabled={!hasMore} onClick={() => onPage((current) => current + 1)}>
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </PageButton>
      </span>
    </div>
  )
}
