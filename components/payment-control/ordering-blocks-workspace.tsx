"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { AlertCircle, ChevronLeft, ChevronRight, RefreshCw, Search, ShieldAlert } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ListSkeleton } from "@/components/ui/skeleton"
import { fetcher } from "@/lib/fetcher"
import {
  DEFAULT_ORDERING_BLOCK_FILTER,
  ORDERING_BLOCKS_DEFAULT_PAGE_SIZE,
  type OrderingBlockBranchView,
  type OrderingBlockBranchesView,
  type OrderingBlockFilter,
  type OrderingBlockStanding,
} from "@/lib/ordering-block-branches"
import { ORDERING_BLOCK_BRANCHES_URL } from "@/lib/ordering-blocks-access"
import { PAYMENT_CONTROL_POLICY } from "@/lib/payment-control-policy"
import { cn, formatDateTime } from "@/lib/utils"

import { PaymentControlPanel } from "./payment-control-panel"

const SEARCH_DEBOUNCE_MS = 300

const FILTERS: ReadonlyArray<{ value: OrderingBlockFilter; label: string }> = [
  { value: "attention", label: "Needs attention" },
  { value: "blocked", label: "Blocked" },
  { value: "exception", label: "On exception" },
  { value: "all", label: "All branches" },
]

const STANDING_LABELS: Record<OrderingBlockStanding, { label: string; className: string }> = {
  BLOCKED: { label: "Ordering blocked", className: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200" },
  EXCEPTION_ACTIVE: { label: "Ordering on exception", className: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200" },
  LAST_ORDER: { label: "One order left", className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200" },
  UNPAID: { label: "Unpaid invoices", className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200" },
  CLEAR: { label: "Clear", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" },
}

const EMPTY_MESSAGES: Record<OrderingBlockFilter, string> = {
  attention: "No branch is blocked, ordering on an exception, or one order from the block.",
  blocked: "No branch is blocked by unpaid invoices.",
  exception: "No branch is ordering on an exception.",
  all: "No active branches.",
}

export function orderingBlockBranchesUrl(input: { filter: OrderingBlockFilter; search: string; page: number }): string {
  const params = new URLSearchParams({ filter: input.filter, page: String(input.page), pageSize: String(ORDERING_BLOCKS_DEFAULT_PAGE_SIZE) })
  if (input.search) params.set("search", input.search)
  return `${ORDERING_BLOCK_BRANCHES_URL}?${params.toString()}`
}

function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

function exceptionLine(exception: OrderingBlockBranchView["exception"]): string {
  if (!exception) return "None"
  if (exception.active) return `Until ${formatDateTime(exception.expiresAt)}`
  if (exception.revokedAt) return `Revoked ${formatDateTime(exception.revokedAt)}`
  return `Expired ${formatDateTime(exception.expiresAt)}`
}

function SummaryTile({ label, value, tone }: Readonly<{ label: string; value: number; tone: string }>) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className={cn("mt-1 text-2xl font-bold", tone)}>{value}</p>
    </div>
  )
}

function BranchRow({ row, threshold, onManage }: Readonly<{
  row: OrderingBlockBranchView
  threshold: number
  onManage: (row: OrderingBlockBranchView) => void
}>) {
  const standing = STANDING_LABELS[row.standing]
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="ordering-block-row">
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-slate-900 dark:text-slate-100">
          {row.branchName}
          {row.branchCode && <span className="ml-2 text-xs font-normal text-slate-500">{row.branchCode}</span>}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <Badge className={standing.className}>{standing.label}</Badge>
          <span>{row.unpaidInvoiceCount} of {threshold} unpaid invoices</span>
          <span className="text-slate-400" aria-hidden="true">·</span>
          <span>Exception: {exceptionLine(row.exception)}</span>
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant={row.standing === "BLOCKED" ? "default" : "outline"}
        className="shrink-0"
        onClick={() => onManage(row)}
        aria-label={`Manage ordering for ${row.branchName}`}
      >
        {row.standing === "BLOCKED" ? "Allow ordering" : "Manage"}
      </Button>
    </li>
  )
}

function DisabledNotice() {
  return (
    <Card className="rounded-2xl border-slate-200 shadow-sm dark:border-slate-800" data-testid="ordering-blocks-disabled">
      <CardContent className="p-8 text-center">
        <ShieldAlert className="mx-auto mb-3 h-10 w-10 text-slate-400" aria-hidden="true" />
        <p className="font-medium text-slate-900 dark:text-slate-100">Ordering is not blocked on unpaid invoices</p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Your organization does not stop branches ordering when invoices go unpaid, so there is nothing to manage here.
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * Head Office's Ordering Blocks page
 * (plans/OF-PAYMENT-CONTROL-head-office-ordering-blocks-page.md): its
 * branches against the unpaid-invoice block, and, per branch, the existing
 * payment-control panel to grant or revoke the one-month exception. What is
 * listed and whether the page applies at all come from the server; the grant
 * and revoke routes re-check everything.
 */
export function OrderingBlocksWorkspace() {
  const [filter, setFilter] = useState<OrderingBlockFilter>(DEFAULT_ORDERING_BLOCK_FILTER)
  const [searchInput, setSearchInput] = useState("")
  const search = useDebounced(searchInput.trim(), SEARCH_DEBOUNCE_MS)
  // The page number belongs to one filter and search: changing either starts again at page 1.
  const listKey = `${filter}|${search}`
  const [pageState, setPageState] = useState({ listKey, page: 1 })
  const page = pageState.listKey === listKey ? pageState.page : 1
  const setPage = (next: number) => setPageState({ listKey, page: next })
  const [managing, setManaging] = useState<OrderingBlockBranchView | null>(null)

  const { data, error, isLoading, mutate } = useSWR<OrderingBlockBranchesView>(
    orderingBlockBranchesUrl({ filter, search, page }),
    fetcher,
    { keepPreviousData: true },
  )

  const enabled = data?.enabled === true ? data : null
  const pageCount = enabled ? Math.max(1, Math.ceil(enabled.total / enabled.pageSize)) : 1

  return (
    <main className="min-h-[calc(100vh-4rem)] space-y-6 bg-slate-50/50 p-4 md:p-8 dark:bg-slate-950">
      <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)] sm:flex-row sm:items-center md:p-5 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-rose-50/50 bg-gradient-to-tr from-rose-100 to-amber-100 shadow-inner dark:border-rose-800/50 dark:from-rose-900/50 dark:to-amber-900/50">
            <ShieldAlert className="h-6 w-6 text-rose-600 dark:text-rose-400" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Ordering Blocks</h1>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {enabled
                ? `A branch stops ordering at ${enabled.threshold} unpaid invoice${enabled.threshold === 1 ? "" : "s"}. You can let a blocked branch keep ordering for ${PAYMENT_CONTROL_POLICY.exceptionDurationMonths === 1 ? "one month" : `${PAYMENT_CONTROL_POLICY.exceptionDurationMonths} months`} at a time.`
                : "Branches stopped from ordering by unpaid invoices"}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" className="h-9 gap-2" onClick={() => mutate()}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>

      {isLoading && !data && (
        <div className="p-6" role="status" aria-live="polite">
          <span className="sr-only">Loading ordering blocks…</span>
          <ListSkeleton rows={4} />
        </div>
      )}

      {error && !data && (
        <div role="alert" className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-white p-6 dark:border-rose-900 dark:bg-slate-900">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden="true" />
          <div>
            <p className="font-medium text-slate-900 dark:text-slate-100">Ordering blocks could not be loaded</p>
            <p className="text-sm text-slate-600 dark:text-slate-400">{error.message || "Try again."}</p>
            <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={() => mutate()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Try again
            </Button>
          </div>
        </div>
      )}

      {data?.enabled === false && <DisabledNotice />}

      {enabled && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <SummaryTile label="Blocked" value={enabled.summary.blocked} tone="text-rose-600 dark:text-rose-400" />
            <SummaryTile label="Ordering on exception" value={enabled.summary.exceptionActive} tone="text-indigo-600 dark:text-indigo-400" />
            <SummaryTile label="One order left" value={enabled.summary.lastOrder} tone="text-amber-600 dark:text-amber-400" />
            <SummaryTile label="Active branches" value={enabled.summary.branches} tone="text-slate-900 dark:text-slate-100" />
          </div>

          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap gap-2">
              {FILTERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={filter === option.value}
                  onClick={() => setFilter(option.value)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-sm font-medium transition",
                    filter === option.value
                      ? "border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200"
                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="relative md:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <Input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                maxLength={100}
                placeholder="Search branch name or code"
                aria-label="Search branches"
                className="pl-9"
              />
            </div>
          </div>

          <Card className="rounded-2xl border-slate-200 shadow-sm dark:border-slate-800">
            <CardContent className="p-0">
              {enabled.items.length === 0 ? (
                <p className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
                  {search ? "No branch matches your search." : EMPTY_MESSAGES[filter]}
                </p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {enabled.items.map((row) => (
                    <BranchRow key={row.branchId} row={row} threshold={enabled.threshold} onManage={setManaging} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {pageCount > 1 && (
            <div className="flex items-center justify-end gap-2 text-sm text-slate-600 dark:text-slate-300">
              <span>Page {enabled.page} of {pageCount}</span>
              <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={page >= pageCount} onClick={() => setPage(page + 1)} aria-label="Next page">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </>
      )}

      <Dialog open={managing !== null} onOpenChange={(open) => { if (!open) setManaging(null) }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{managing?.branchName}</DialogTitle>
            <DialogDescription>
              Unpaid invoices, the Head Office exception, and what happens next for this branch.
            </DialogDescription>
          </DialogHeader>
          {managing && <PaymentControlPanel branchId={managing.branchId} onChanged={() => { void mutate() }} />}
        </DialogContent>
      </Dialog>
    </main>
  )
}
