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
  BUDGET_BURN_REASON_LABELS,
  BUDGET_BURN_THRESHOLDS,
  BUDGET_BURN_TREND_MONTHS,
  appDayKey,
  currentAppMonth,
  monthsBetween,
  type BudgetBurnReason,
  type BudgetBurnThresholds,
  type WatchlistMetrics,
} from "@/lib/budget-burn-risk"
import type { DrillDownStatusSet } from "@/lib/executive-analytics"
import { ChartMessage, money } from "./chart-kit"
import type { DrillTarget } from "./comparison-charts"
import { toQuery, type ExecutiveFilterState } from "./executive-filters"

/**
 * "Users to review" — requesters whose consumption of a shared branch budget
 * looks unusual this month, ranked by a documented score.
 *
 * Everything here is presentation. The server decides who may read the list
 * (`isBudgetBurnRole`, after the executive scope), which rows exist for them,
 * and what each figure is; this component draws the answer and hands a click
 * on a row to the existing drill-down as a requester × branch target for the
 * same month. The copy is part of the contract: the list shows patterns for a
 * human to look at and says so, because a score is not evidence of intent.
 *
 * Only the scope filters travel with the request. Category, product and
 * requester focus would turn "share of the branch budget" into a different
 * (line-grain) question, so they are dropped here and the panel says so.
 */

export type BudgetBurnRow = {
  userId: string
  requesterName: string
  employeeId: string | null
  role: string
  accountStatus: "ACTIVE" | "INACTIVE" | "DELETED"
  branchId: number
  branchName: string
  score: number
  reasons: BudgetBurnReason[]
  metrics: WatchlistMetrics
}

export type BudgetBurnTrendWindow = { startMonth: string; endMonth: string; startDate: string; endDate: string }

export type BudgetBurnResponse = {
  month: string
  windows: {
    current: { startDate: string; endDate: string; complete: boolean; elapsedDays: number; daysInMonth: number }
    /** The growth comparison's two runs of months — the one figure not about the selected month alone. */
    trend: { months: number; current: BudgetBurnTrendWindow; prior: BudgetBurnTrendWindow }
    recent: { startDate: string; endDate: string }
  }
  rows: BudgetBurnRow[]
  branches: Array<{ branchId: number; branchName: string; consumedCents: number; otherCreatorsConsumedCents: number; activeRequesterCount: number; totalBudgetCents: number; remainingCents: number }>
  flaggedCount: number
  unflaggedCount: number
  limit: number
  truncated: boolean
  thresholds: BudgetBurnThresholds
  reasonLabels: Record<BudgetBurnReason, string>
  error?: string
}

/** What a row click hands the page: the drill target and the filters that reconcile with it. */
export type BudgetBurnDrillSelection = {
  target: DrillTarget
  filters: ExecutiveFilterState
  /**
   * Always `consumed`: the row's figure is Spend + Pending, so the listing
   * must include the pending orders or a pending-only month drills into an
   * empty table.
   */
  statuses: DrillDownStatusSet
  month: string
  requesterName: string
  branchName: string
  spendCents: number
  pendingCents: number
  pendingOrderCount: number
}

/** The requester + branch + month whose item-wise trend table should open. */
export type BudgetBurnItemDrillSelection = {
  userId: string
  branchId: number
  requesterName: string
  branchName: string
  month: string
}

export const NOT_PROOF_COPY = "Unusual consumption patterns for review — not proof of intent."
export const SCOPE_NOTE_COPY = "Organization, group and branch filters apply. Category, product and requester focus do not."

const monthFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", month: "long", year: "numeric" })
const dayFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", day: "numeric", month: "short" })

export function monthLabel(month: string): string {
  return monthFormatter.format(new Date(`${month}-01T00:00:00.000+05:00`))
}

const shortMonthFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", month: "short", year: "numeric" })

function shortMonthLabel(month: string): string {
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

function percent(value: number, digits = 1): string {
  return `${(Number.isFinite(value) ? value : 0).toFixed(digits)}%`
}

/** The threshold behind each chip, in the reader's words, so a chip is never just a colour. */
export function reasonExplanation(reason: BudgetBurnReason, t: BudgetBurnThresholds): string {
  switch (reason) {
    case "high_share":
      return `At least ${t.highSharePct}% of everything the branch consumed this month, with at least ${t.highShareMinRequesters} active requesters there.`
    case "trend_spike":
      return `At least +${t.trendSpikePct}% on the previous ${BUDGET_BURN_TREND_MONTHS} months, from a baseline of at least ${money(t.trendMinBaselineCents)}.`
    case "above_peers":
      return `The branch's budget utilization is at least ${t.abovePeersPct}% above the median budget utilization of the other branches in scope.`
    case "late_surge":
      return `At least ${t.lateSurgePct}% of the month's consumption landed in the last ${t.lateSurgeDays} days.`
    case "high_held":
      return `Pending orders holding at least ${t.highHeldPctOfBudget}% of the branch's budget (or ${money(t.highHeldFloorCents)} where it has none).`
    case "rejected_orders":
      return `At least ${t.rejectedOrdersMin} orders rejected by an approver this month.`
  }
}

/** The month window as the date-only filters the drill-down parses in Asia/Karachi. */
export function drillFiltersFor(filters: ExecutiveFilterState, windows: BudgetBurnResponse["windows"]): ExecutiveFilterState {
  return {
    ...filters,
    startDate: appDayKey(new Date(windows.current.startDate)),
    endDate: appDayKey(new Date(windows.current.endDate)),
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

function ReasonChips({ reasons, thresholds, labels }: Readonly<{
  reasons: BudgetBurnReason[]
  thresholds: BudgetBurnThresholds
  labels: Record<BudgetBurnReason, string>
}>) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Why flagged">
      {reasons.map((reason) => (
        <li
          key={reason}
          title={reasonExplanation(reason, thresholds)}
          className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
        >
          {labels[reason] ?? BUDGET_BURN_REASON_LABELS[reason]}
        </li>
      ))}
    </ul>
  )
}

const COLUMNS = [
  { label: "Requester", numeric: false },
  { label: "Branch", numeric: false },
  { label: "Spend", numeric: true },
  { label: "Pending", numeric: true },
  { label: "Share", numeric: true },
  { label: `${BUDGET_BURN_TREND_MONTHS}M`, numeric: true },
  { label: "vs peers", numeric: true },
  { label: "Orders", numeric: true },
  { label: "Why", numeric: false },
  { label: "Score", numeric: true },
] as const

function rowKey(row: Pick<BudgetBurnRow, "userId" | "branchId">): string {
  return `${row.userId}:${row.branchId}`
}

/**
 * The growth cell's tooltip. It names both runs of months and both totals,
 * because the percentage is no longer a ratio of the Spend beside it — a
 * reader who cannot see where it came from would reasonably assume it was.
 */
export function trendCellTitle(
  metrics: Pick<WatchlistMetrics, "trendPct" | "trendConsumedCents" | "priorTrendConsumedCents">,
  trend: BudgetBurnResponse["windows"]["trend"],
): string {
  const current = `${monthRangeLabel(trend.current.startMonth, trend.current.endMonth)}: ${money(metrics.trendConsumedCents)}`
  const prior = `${monthRangeLabel(trend.prior.startMonth, trend.prior.endMonth)}: ${money(metrics.priorTrendConsumedCents)}`
  const baseline = metrics.trendPct === null ? " Nothing consumed in the earlier window to compare against." : ""
  return `${current} · ${prior}.${baseline} Open item detail.`
}

function WatchlistTable({ data, selectedKey, selectedItemsKey, onSelect, onSelectItems }: Readonly<{
  data: BudgetBurnResponse
  selectedKey: string | null
  selectedItemsKey: string | null
  onSelect: (row: BudgetBurnRow) => void
  onSelectItems?: (row: BudgetBurnRow) => void
}>) {
  return (
    <div className="max-h-[420px] overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800">
          <tr>
            {COLUMNS.map((column) => (
              <th key={column.label} scope="col" className={cn("px-2.5 py-2 font-semibold text-slate-600 dark:text-slate-300", column.numeric ? "text-right" : "text-left")}>
                {column.label}
              </th>
            ))}
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
                    onClick={() => onSelect(row)}
                    aria-pressed={selected}
                    className="text-left font-semibold text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300"
                  >
                    {row.requesterName}
                  </button>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">
                    {[row.employeeId, row.role.replace(/_/g, " ").toLowerCase(), row.accountStatus !== "ACTIVE" ? row.accountStatus.toLowerCase() : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </td>
                <td className="px-2.5 py-2 text-slate-700 dark:text-slate-300">{row.branchName}</td>
                <td className="px-2.5 py-2 text-right tabular-nums">{money(m.spendCents)}</td>
                <td className="px-2.5 py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">
                  {m.pendingCents > 0 ? `${money(m.pendingCents)} (${m.pendingOrderCount})` : "—"}
                </td>
                <td className="px-2.5 py-2 text-right tabular-nums">{percent(m.shareOfBranchPct)}</td>
                <td className="px-2.5 py-2 text-right tabular-nums">
                  {onSelectItems ? (
                    <button
                      type="button"
                      onClick={() => onSelectItems(row)}
                      aria-label={`Compare ${row.requesterName} items over ${data.windows.trend.months} months`}
                      aria-pressed={itemsSelected}
                      title={trendCellTitle(m, data.windows.trend)}
                      className={cn(
                        "rounded px-1 font-semibold text-indigo-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300",
                        itemsSelected && "bg-indigo-100 dark:bg-indigo-500/20",
                      )}
                    >
                      {signedPercent(m.trendPct)}
                    </button>
                  ) : signedPercent(m.trendPct)}
                </td>
                <td
                  className="px-2.5 py-2 text-right tabular-nums"
                  title={m.vsPeerPct === null
                    ? `Fewer than ${data.thresholds.branchPeersMinCount} other branches with a budget to compare against`
                    : `This branch: ${percent(m.branchUtilizationPct ?? 0)} of budget · peer branch median: ${percent(m.peerBranchMedianUtilizationPct ?? 0)}`}
                >
                  {signedPercent(m.vsPeerPct)}
                </td>
                <td className="px-2.5 py-2 text-right tabular-nums" title={`${m.orderCount} counted · ${m.pendingOrderCount} pending · ${m.rejectedOrderCount} rejected`}>
                  {m.orderCount}{m.pendingOrderCount > 0 ? ` · ${m.pendingOrderCount} pending` : ""}{m.rejectedOrderCount > 0 ? ` · ${m.rejectedOrderCount} rej.` : ""}
                </td>
                <td className="px-2.5 py-2"><ReasonChips reasons={row.reasons} thresholds={data.thresholds} labels={data.reasonLabels} /></td>
                <td className="px-2.5 py-2 text-right font-semibold tabular-nums">{row.score}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function EmptyState({ unflaggedCount, flagScore }: Readonly<{ unflaggedCount: number; flagScore: number }>) {
  return (
    <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-200 px-6 text-center dark:border-slate-700">
      <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">Nothing to review</p>
      <p className="max-w-sm text-xs text-slate-500 dark:text-slate-400">
        {unflaggedCount === 0
          ? "No requester consumed budget in this month and scope."
          : `${unflaggedCount} requester${unflaggedCount === 1 ? "" : "s"} consumed budget; none reached the review score of ${flagScore}.`}
      </p>
    </div>
  )
}

/** Loading, error, empty and rows are mutually exclusive; this picks one. */
function WatchlistBody({ data, loading, error, thresholds, selectedKey, selectedItemsKey, onSelect, onSelectItems }: Readonly<{
  data: BudgetBurnResponse | undefined
  loading: boolean
  error: string | null
  thresholds: BudgetBurnThresholds
  selectedKey: string | null
  selectedItemsKey: string | null
  onSelect: (row: BudgetBurnRow) => void
  onSelectItems?: (row: BudgetBurnRow) => void
}>) {
  if (loading && !data) return <Skeleton className="h-[240px] w-full rounded-lg" />
  if (error) return <ChartMessage tone="error" message={error} />
  if (!data) return null
  if (data.rows.length === 0) return <EmptyState unflaggedCount={data.unflaggedCount} flagScore={thresholds.flagScore} />
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
        Showing {data.rows.length} of {data.flaggedCount} flagged · {data.unflaggedCount} below the review score of {thresholds.flagScore}.
        {" "}Click a name for the order lines behind Spend, or a {data.windows.trend.months}M value for its item-wise comparison.
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
 * Says which months the growth column spans, because it is the one figure on
 * the panel that is not the selected month.
 */
export function trendNote(trend: BudgetBurnResponse["windows"]["trend"]): string {
  return `The ${trend.months}M column compares ${monthRangeLabel(trend.current.startMonth, trend.current.endMonth)}`
    + ` against ${monthRangeLabel(trend.prior.startMonth, trend.prior.endMonth)}; every other figure is the month alone.`
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

  const select = React.useCallback((row: BudgetBurnRow) => {
    if (!data) return
    onDrill({
      target: {
        dimension: "user",
        key: row.userId,
        label: row.requesterName,
        narrow: { branchIds: [String(row.branchId)] },
      },
      filters: drillFiltersFor(filters, data.windows),
      statuses: "consumed",
      month: data.month,
      requesterName: row.requesterName,
      branchName: row.branchName,
      spendCents: row.metrics.spendCents,
      pendingCents: row.metrics.pendingCents,
      pendingOrderCount: row.metrics.pendingOrderCount,
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
          {data ? ` Showing ${monthLabel(data.month)} ${windowLabel(data.windows)}. ${trendNote(data.windows.trend)}` : ""}
        </p>

        <div className="mt-3">
          <WatchlistBody
            data={data}
            loading={isLoading}
            error={requestError}
            thresholds={thresholds}
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
 * order line behind Spend + Pending, and says which part is still only
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
        {selection.pendingOrderCount > 0
          ? ` plus ${selection.pendingOrderCount} pending order${selection.pendingOrderCount === 1 ? "" : "s"} totalling ${money(selection.pendingCents)}, marked pending below. Nothing pending is counted until it is approved.`
          : ". There are no pending orders for this requester in the month."}
      </p>
      <button type="button" onClick={onClose} className="text-[11px] font-semibold text-indigo-700 hover:underline dark:text-indigo-300">
        Close
      </button>
    </div>
  )
}
