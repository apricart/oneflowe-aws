"use client"

import * as React from "react"
import { AlertTriangle, ChevronLeft, ChevronRight, UserSearch } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useAPI } from "@/lib/hooks/use-api"
import { cn } from "@/lib/utils"
import {
  BUDGET_BURN_DEFAULT_ROWS,
  BUDGET_BURN_MAX_MONTHS_BACK,
  BUDGET_BURN_THRESHOLDS,
  appDayKey,
  currentAppMonth,
  monthsBetween,
  type BudgetBurnThresholds,
  type MonthConsumption,
  type WatchlistMetrics,
} from "@/lib/budget-burn-risk"
import type { DrillDownStatusSet } from "@/lib/executive-analytics"
import { renamedRoleName } from "@/lib/role-display-names"
import { ChartMessage, money } from "./chart-kit"
import type { DrillTarget } from "./comparison-charts"
import { toQuery, type ExecutiveFilterState } from "./executive-filters"

/**
 * "Users to review" — what each requester consumed in each of the last
 * few months (the server decides how many), with the newest month highlighted
 * where it is at least `momSpikePct` above the one before it.
 *
 * Everything here is presentation. The server decides who may read the list
 * (`isBudgetBurnRole`, after the executive scope), which rows exist for them,
 * and what every figure is; this component draws the answer and hands a click
 * to the existing drill-down. The copy is part of the contract: the panel
 * shows patterns for a human to look at and says so, because a percentage is
 * not evidence of intent.
 *
 * Two rules the design turns on. The three month cells and the percentage are
 * the *same* numbers — the percentage is a ratio of the last two cells, so a
 * reader can check it without leaving the row. And the highlight is never
 * carried by colour alone: a highlighted cell also carries a marker and an
 * accessible label naming both amounts and the threshold, so the row reads
 * correctly to a screen reader, in print and in monochrome.
 *
 * Only the scope filters travel with the request. Category, product and
 * requester focus would turn "consumption of the branch budget" into a
 * different (line-grain) question, so they are dropped here and the panel
 * says so.
 */

/**
 * The fields this panel draws. The response also carries `score`, `reasons`,
 * `points` and `reasonLabels` from the retired multi-signal rule — still
 * computed and still tested, but deliberately not drawn here, because the
 * client asked for a screen that needs no second signal to read.
 */
export type BudgetBurnRow = {
  userId: string
  requesterName: string
  employeeId: string | null
  role: string
  accountStatus: "ACTIVE" | "INACTIVE" | "DELETED"
  branchId: number
  branchName: string
  metrics: WatchlistMetrics
}

export type BudgetBurnPatternBucket = {
  month: string
  startDate: string
  endDate: string
  complete: boolean
}

export type BudgetBurnResponse = {
  month: string
  windows: {
    current: { startDate: string; endDate: string; complete: boolean; elapsedDays: number; daysInMonth: number }
    /** The months the panel draws, oldest first; the last is the selected month. */
    pattern: BudgetBurnPatternBucket[]
    recent: { startDate: string; endDate: string }
  }
  rows: BudgetBurnRow[]
  branches: Array<{ branchId: number; branchName: string; consumedCents: number; otherCreatorsConsumedCents: number; activeRequesterCount: number; totalBudgetCents: number; remainingCents: number }>
  highlightedCount: number
  requesterCount: number
  limit: number
  truncated: boolean
  thresholds: BudgetBurnThresholds
  error?: string
}

/** What a cell click hands the page: the drill target and the filters that reconcile with it. */
export type BudgetBurnDrillSelection = {
  target: DrillTarget
  filters: ExecutiveFilterState
  /**
   * Always `consumed`: a month cell is Spend + Pending, so the listing must
   * include the pending orders or a pending-only month drills into an empty
   * table.
   */
  statuses: DrillDownStatusSet
  month: string
  requesterName: string
  branchName: string
  spendCents: number
  pendingCents: number
  /**
   * Null for a month other than the selected one — the aggregate counts
   * orders for the selected month only, and a note must not invent a number
   * it was not given.
   */
  pendingOrderCount: number | null
}

/** The requester + branch + month whose item-wise pattern should open. */
export type BudgetBurnItemDrillSelection = {
  userId: string
  branchId: number
  requesterName: string
  branchName: string
  month: string
}

export const NOT_PROOF_COPY = "Three months of consumption per requester — for review, not proof of intent."
export const SCOPE_NOTE_COPY = "Organization, group and branch filters apply. Category, product and requester focus do not."

const monthFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", month: "long", year: "numeric" })
const dayFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", day: "numeric", month: "short" })

export function monthLabel(month: string): string {
  return monthFormatter.format(new Date(`${month}-01T00:00:00.000+05:00`))
}

const shortMonthFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", month: "short", year: "numeric" })

export function shortMonthLabel(month: string): string {
  return shortMonthFormatter.format(new Date(`${month}-01T00:00:00.000+05:00`))
}

/**
 * A run of months as one label — `May 2026–Jul 2026`, or just the month when
 * a run is one month long. The year is repeated on both ends deliberately: a
 * run can straddle a year boundary, and `Nov–Jan 2026` would be ambiguous.
 */
export function monthRangeLabel(startMonth: string, endMonth: string): string {
  if (startMonth === endMonth) return monthLabel(startMonth)
  return `${shortMonthLabel(startMonth)}–${shortMonthLabel(endMonth)}`
}

export function signedPercent(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return "—"
  const sign = value > 0 ? "+" : ""
  return `${sign}${value.toFixed(digits)}%`
}

/** Shown beside a highlighted figure, so the highlight never depends on colour alone. */
export const HIGHLIGHT_MARKER = "▲"

const HIGHLIGHT_CELL_CLASS = "bg-rose-50 font-semibold text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"

/**
 * What a highlighted row means, in full, for the cell's accessible label and
 * tooltip. Names both months, both amounts and the threshold, so a reader who
 * cannot see the colour still learns everything the colour was carrying.
 */
export function momCellTitle(metrics: Pick<WatchlistMetrics, "months" | "momPct" | "momFlagged">, thresholds: BudgetBurnThresholds): string {
  const current = metrics.months.at(-1)
  const previous = metrics.months.at(-2)
  if (!current || !previous) return "No earlier month to compare against."
  const pair = `${monthLabel(previous.month)}: ${money(previous.consumedCents)} → ${monthLabel(current.month)}: ${money(current.consumedCents)}.`
  if (metrics.momPct === null) {
    return `${pair} Nothing consumed in ${monthLabel(previous.month)}, so there is no baseline to compare against.`
  }
  const verdict = metrics.momFlagged
    ? `At or above the ${thresholds.momSpikePct}% review threshold.`
    : `Below the ${thresholds.momSpikePct}% review threshold${previous.consumedCents < thresholds.momMinBaselineCents
      ? `, and the previous month is under the ${money(thresholds.momMinBaselineCents)} baseline`
      : ""}.`
  return `${pair} ${signedPercent(metrics.momPct, 1)}. ${verdict} Open the item-wise detail.`
}

/** One month cell's tooltip: what it is made of, and what a click on it opens. */
export function monthCellTitle(cell: MonthConsumption): string {
  const pending = cell.pendingCents > 0 ? ` — Spend ${money(cell.spendCents)} plus ${money(cell.pendingCents)} still pending` : ""
  return `${monthLabel(cell.month)}: ${money(cell.consumedCents)}${pending}. Open the order lines behind it.`
}

/** A pattern month as the date-only filters the drill-down parses in Asia/Karachi. */
export function drillFiltersFor(filters: ExecutiveFilterState, bucket: Pick<BudgetBurnPatternBucket, "startDate" | "endDate">): ExecutiveFilterState {
  return {
    ...filters,
    startDate: appDayKey(new Date(bucket.startDate)),
    endDate: appDayKey(new Date(bucket.endDate)),
    categoryIds: [],
    productIds: [],
    userIds: [],
  }
}

/** Only the scope filters reach the request. */
function scopeOnly(filters: ExecutiveFilterState): ExecutiveFilterState {
  return { ...filters, startDate: "", endDate: "", categoryIds: [], productIds: [], userIds: [] }
}

function MonthNav({ month, current, onChange }: Readonly<{ month: string; current: string; onChange: (next: string) => void }>) {
  const back = monthsBetween(month, current)
  const step = (delta: number) => {
    const [year, mon] = month.split("-").map(Number)
    const date = new Date(Date.UTC(year, mon - 1 + delta, 1))
    onChange(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`)
  }
  const buttonClass = "rounded-md border border-slate-200 p-1 text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/60"
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="Month">
      <button type="button" className={buttonClass} aria-label="Previous month" disabled={back >= BUDGET_BURN_MAX_MONTHS_BACK} onClick={() => step(-1)}>
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
      </button>
      <span className="min-w-[8.5rem] text-center text-xs font-semibold text-slate-800 dark:text-slate-200">{monthLabel(month)}</span>
      <button type="button" className={buttonClass} aria-label="Next month" disabled={back <= 0} onClick={() => step(1)}>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  )
}

function rowKey(row: Pick<BudgetBurnRow, "userId" | "branchId">): string {
  return `${row.userId}:${row.branchId}`
}

/** One month's consumption, clickable into the order lines behind that month alone. */
function MonthCell({ cell, highlighted, requesterName, onOpen }: Readonly<{
  cell: MonthConsumption
  highlighted: boolean
  requesterName: string
  onOpen: () => void
}>) {
  return (
    <td className={cn("px-2.5 py-2 text-right tabular-nums", highlighted && HIGHLIGHT_CELL_CLASS)}>
      <button
        type="button"
        onClick={onOpen}
        title={monthCellTitle(cell)}
        aria-label={`${requesterName}, ${monthLabel(cell.month)}: ${money(cell.consumedCents)}${highlighted ? " — highlighted" : ""}. Open the order lines behind it.`}
        className="rounded px-1 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        {highlighted ? <span aria-hidden className="mr-0.5">{HIGHLIGHT_MARKER}</span> : null}
        {money(cell.consumedCents)}
      </button>
      {cell.pendingCents > 0 ? (
        <div className="text-[10px] font-normal text-slate-500 dark:text-slate-400">incl. {money(cell.pendingCents)} pending</div>
      ) : null}
    </td>
  )
}

function WatchlistTable({ data, selectedKey, selectedItemsKey, onSelect, onSelectItems }: Readonly<{
  data: BudgetBurnResponse
  selectedKey: string | null
  selectedItemsKey: string | null
  onSelect: (row: BudgetBurnRow, index: number) => void
  onSelectItems?: (row: BudgetBurnRow) => void
}>) {
  const lastIndex = data.windows.pattern.length - 1
  return (
    <div className="max-h-[420px] overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800">
          <tr>
            <th scope="col" className="px-2.5 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">Requester</th>
            <th scope="col" className="px-2.5 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">Branch</th>
            {data.windows.pattern.map((bucket) => (
              <th key={bucket.month} scope="col" className="whitespace-nowrap px-2.5 py-2 text-right font-semibold text-slate-600 dark:text-slate-300">
                {shortMonthLabel(bucket.month)}
              </th>
            ))}
            <th scope="col" className="whitespace-nowrap px-2.5 py-2 text-right font-semibold text-slate-600 dark:text-slate-300">vs prev month</th>
            <th scope="col" className="px-2.5 py-2 text-right font-semibold text-slate-600 dark:text-slate-300">Orders</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => {
            const key = rowKey(row)
            const selected = key === selectedKey
            const itemsSelected = `${key}:${data.month}` === selectedItemsKey
            const m = row.metrics
            return (
              <tr
                key={key}
                className={cn(
                  "border-t border-slate-100 dark:border-slate-800",
                  selected ? "bg-indigo-50/70 dark:bg-indigo-500/10" : "hover:bg-slate-50 dark:hover:bg-slate-800/60",
                )}
              >
                <td className="px-2.5 py-2">
                  <button
                    type="button"
                    onClick={() => onSelect(row, lastIndex)}
                    aria-pressed={selected}
                    className="text-left font-semibold text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300"
                  >
                    {row.requesterName}
                  </button>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">
                    {[row.employeeId, (renamedRoleName(row.role) ?? row.role.replace(/_/g, " ")).toLowerCase(), row.accountStatus !== "ACTIVE" ? row.accountStatus.toLowerCase() : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </td>
                <td className="px-2.5 py-2 text-slate-700 dark:text-slate-300">{row.branchName}</td>
                {m.months.map((cell, index) => (
                  <MonthCell
                    key={cell.month}
                    cell={cell}
                    highlighted={m.momFlagged && index === lastIndex}
                    requesterName={row.requesterName}
                    onOpen={() => onSelect(row, index)}
                  />
                ))}
                <td className={cn("px-2.5 py-2 text-right tabular-nums", m.momFlagged && HIGHLIGHT_CELL_CLASS)}>
                  {onSelectItems ? (
                    <button
                      type="button"
                      onClick={() => onSelectItems(row)}
                      aria-label={`${row.requesterName}: ${momCellTitle(m, data.thresholds)}`}
                      aria-pressed={itemsSelected}
                      title={momCellTitle(m, data.thresholds)}
                      className={cn(
                        "rounded px-1 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                        !m.momFlagged && "text-indigo-700 dark:text-indigo-300",
                        itemsSelected && !m.momFlagged && "bg-indigo-100 dark:bg-indigo-500/20",
                      )}
                    >
                      {m.momFlagged ? <span aria-hidden className="mr-0.5">{HIGHLIGHT_MARKER}</span> : null}
                      {signedPercent(m.momPct)}
                    </button>
                  ) : (
                    <span title={momCellTitle(m, data.thresholds)}>
                      {m.momFlagged ? <span aria-hidden className="mr-0.5">{HIGHLIGHT_MARKER}</span> : null}
                      {signedPercent(m.momPct)}
                    </span>
                  )}
                </td>
                <td className="px-2.5 py-2 text-right tabular-nums" title={`${m.orderCount} counted · ${m.pendingOrderCount} pending · ${m.rejectedOrderCount} rejected, in ${monthLabel(data.month)}`}>
                  {m.orderCount}{m.pendingOrderCount > 0 ? ` · ${m.pendingOrderCount} pending` : ""}{m.rejectedOrderCount > 0 ? ` · ${m.rejectedOrderCount} rej.` : ""}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-200 px-6 text-center dark:border-slate-700">
      <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">Nothing to review</p>
      <p className="max-w-sm text-xs text-slate-500 dark:text-slate-400">
        No requester consumed budget in these months and this scope.
      </p>
    </div>
  )
}

/** Loading, error, empty and rows are mutually exclusive; this picks one. */
function WatchlistBody({ data, loading, error, selectedKey, selectedItemsKey, onSelect, onSelectItems }: Readonly<{
  data: BudgetBurnResponse | undefined
  loading: boolean
  error: string | null
  selectedKey: string | null
  selectedItemsKey: string | null
  onSelect: (row: BudgetBurnRow, index: number) => void
  onSelectItems?: (row: BudgetBurnRow) => void
}>) {
  if (loading && !data) return <Skeleton className="h-[240px] w-full rounded-lg" />
  if (error) return <ChartMessage tone="error" message={error} />
  if (!data) return null
  if (data.rows.length === 0) return <EmptyState />
  return (
    <>
      <WatchlistTable
        data={data}
        selectedKey={selectedKey}
        selectedItemsKey={selectedItemsKey}
        onSelect={onSelect}
        onSelectItems={onSelectItems}
      />
      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
        Showing {data.rows.length} of {data.requesterCount} requester{data.requesterCount === 1 ? "" : "s"}
        {" · "}{data.highlightedCount} highlighted.
        {" "}Click a month for the order lines behind it, or the percentage for the item-wise comparison.
      </p>
      {data.truncated ? (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          The read hit its row cap; the quietest requesters may be missing. Narrow the scope.
        </p>
      ) : null}
    </>
  )
}

function windowLabel(windows: BudgetBurnResponse["windows"]): string {
  if (windows.current.complete) return "whole month"
  return `to ${dayFormatter.format(new Date(windows.current.endDate))}, day ${windows.current.elapsedDays} of ${windows.current.daysInMonth}`
}

/**
 * What the highlight means, printed rather than implied. A colour with no
 * stated rule is a rumour; this is the rule.
 */
export function highlightNote(pattern: BudgetBurnPatternBucket[], thresholds: BudgetBurnThresholds): string {
  const first = pattern[0]?.month
  const last = pattern.at(-1)?.month
  const span = first && last ? `${monthRangeLabel(first, last)} shown, each month on its own. ` : ""
  return `${span}Highlighted when the selected month is at least ${thresholds.momSpikePct}% above the previous month,`
    + ` from a previous month of at least ${money(thresholds.momMinBaselineCents)}.`
}

export function BudgetBurnWatchlist({ filters, onDrill, onDrillItems, selectedKey = null, selectedItemsKey = null }: Readonly<{
  filters: ExecutiveFilterState
  onDrill: (selection: BudgetBurnDrillSelection) => void
  onDrillItems?: (selection: BudgetBurnItemDrillSelection) => void
  /** `userId:branchId` of the row whose drill-down is open, if any. */
  selectedKey?: string | null
  /** `userId:branchId:month` of the row whose item comparison is open. */
  selectedItemsKey?: string | null
}>) {
  // Read once, so the panel is not re-anchored mid-session and render stays pure.
  const [current] = React.useState(() => currentAppMonth(new Date()))
  const [month, setMonth] = React.useState(current)

  const url = `/api/v1/analytics/executive/budget-burn?${toQuery(scopeOnly(filters), { month, limit: String(BUDGET_BURN_DEFAULT_ROWS) })}`
  const { data, error, isLoading } = useAPI<BudgetBurnResponse>(url)

  const requestError = error
    ? "The watchlist could not be loaded. Your session may have expired, or the selected month returned an error."
    : data?.error ?? null

  const select = React.useCallback((row: BudgetBurnRow, index: number) => {
    if (!data) return
    const bucket = data.windows.pattern[index]
    const cell = row.metrics.months[index]
    if (!bucket || !cell) return
    const isSelectedMonth = index === data.windows.pattern.length - 1
    onDrill({
      target: {
        dimension: "user",
        key: row.userId,
        label: row.requesterName,
        narrow: { branchIds: [String(row.branchId)] },
      },
      filters: drillFiltersFor(filters, bucket),
      statuses: "consumed",
      month: cell.month,
      requesterName: row.requesterName,
      branchName: row.branchName,
      spendCents: cell.spendCents,
      pendingCents: cell.pendingCents,
      // The aggregate counts orders for the selected month alone.
      pendingOrderCount: isSelectedMonth ? row.metrics.pendingOrderCount : null,
    })
  }, [data, filters, onDrill])

  const selectItems = React.useCallback((row: BudgetBurnRow) => {
    if (!data || !onDrillItems) return
    onDrillItems({
      userId: row.userId,
      branchId: row.branchId,
      requesterName: row.requesterName,
      branchName: row.branchName,
      month: data.month,
    })
  }, [data, onDrillItems])

  const thresholds = data?.thresholds ?? BUDGET_BURN_THRESHOLDS

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
              <UserSearch className="h-4 w-4 text-indigo-600" aria-hidden />
              Users to review
            </h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{NOT_PROOF_COPY}</p>
          </div>
          <MonthNav month={month} current={current} onChange={setMonth} />
        </div>
        <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          {SCOPE_NOTE_COPY}
          {data ? ` ${monthLabel(data.month)} is the ${windowLabel(data.windows)}. ${highlightNote(data.windows.pattern, thresholds)}` : ""}
        </p>

        <div className="mt-3">
          <WatchlistBody
            data={data}
            loading={isLoading}
            error={requestError}
            selectedKey={selectedKey}
            selectedItemsKey={selectedItemsKey}
            onSelect={select}
            onSelectItems={onDrillItems ? selectItems : undefined}
          />
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * The line above the drill-down that keeps it honest: the table lists every
 * order line behind that month's figure, and says which part is still only
 * pending, because a pending line looks like a purchase and is not one yet.
 */
export function BudgetBurnDrillNote({ selection, onClose }: Readonly<{
  selection: BudgetBurnDrillSelection
  onClose: () => void
}>) {
  const consumed = selection.spendCents + selection.pendingCents
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2 text-xs text-slate-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-slate-200">
      <p>
        <span className="font-semibold">{selection.requesterName}</span> at {selection.branchName}, {monthLabel(selection.month)}: the lines below add up to
        {" "}<span className="font-semibold tabular-nums">{money(consumed)}</span> — Spend {money(selection.spendCents)}
        {pendingSentence(selection)}
      </p>
      <button type="button" onClick={onClose} className="text-[11px] font-semibold text-indigo-700 hover:underline dark:text-indigo-300">
        Close
      </button>
    </div>
  )
}

/** The pending half of the note — with the order count where the month reported one. */
function pendingSentence(selection: BudgetBurnDrillSelection): string {
  if (selection.pendingCents <= 0) {
    return ". There are no pending orders for this requester in the month."
  }
  const count = selection.pendingOrderCount
  const orders = count === null
    ? `${money(selection.pendingCents)} in pending orders`
    : `${count} pending order${count === 1 ? "" : "s"} totalling ${money(selection.pendingCents)}`
  return ` plus ${orders}, marked pending below. Nothing pending is counted until it is approved.`
}
