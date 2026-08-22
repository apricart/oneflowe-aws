"use client"

import { useCallback, useMemo, useState } from "react"
import useSWR from "swr"
import jsPDF from "jspdf"
import autoTable from "jspdf-autotable"
import * as XLSX from "xlsx"
import {
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  Inbox,
  Layers,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Wallet,
} from "lucide-react"
import { useSession } from "next-auth/react"

import { GlobalDateFilter, type FilterPreset, type GlobalDateFilterChange } from "@/components/dashboard/global-date-filter"
import { GroupFilter } from "@/components/reports/group-filter"
import { KPICard } from "@/components/reports/kpi-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ListSkeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useDebounce } from "@/hooks/use-debounce"
import { useToast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import { sanitizeSpreadsheetRow } from "@/lib/spreadsheet"
import { formatQuantity } from "@/lib/quantity"
import { cn, formatPKR } from "@/lib/utils"
import type { DateRange } from "@/lib/hooks/use-sales-performance"

import { STATUS_STYLES, formatDateTime } from "./approval-types"

/**
 * The Group User's group order report.
 *
 * The approval queue answers "what needs deciding"; this answers "what was
 * ordered". Every row is a group order — the GRP reference a Group Order Portal
 * submission was raised under — with the branch orders inside this approver's
 * assigned branches beneath it, plus a roll-up of the same filtered set by
 * group.
 *
 * The endpoint behind it resolves the branch scope from the session, so nothing
 * here can widen what is returned; the filters below only ever narrow it.
 */

const PAGE_SIZE = 10
const EXPORT_PAGE_SIZE = 50
const EXPORT_PAGE_LIMIT = 40

const STATUS_OPTIONS = [
  { value: "ALL", label: "All statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "FULFILLED", label: "Fulfilled" },
  { value: "REJECTED", label: "Rejected" },
  { value: "REFUNDED", label: "Refunded" },
] as const

type ReportChild = {
  id: number
  tid: string
  branchId: number
  branchName: string
  branchCostCenterId: string | null
  status: string
  fulfillmentStatus: string
  totalCents: number
  refundCents: number
  itemCount: number
  quantityOrdered: number
  createdAt: string | null
  approvedAt: string | null
  rejectionReason: string | null
}

type ReportRow = {
  id: number
  reference: string
  createdAt: string | null
  notes: string | null
  groupId: number | null
  groupName: string
  requestedByName: string
  scopedOrderCount: number
  branchCount: number
  quantityOrdered: number
  totalCents: number
  refundCents: number
  netCents: number
  statusCounts: Record<string, number>
  orders: ReportChild[]
}

type ReportSummary = {
  groupOrderCount: number
  branchOrderCount: number
  branchCount: number
  quantityOrdered: number
  totalCents: number
  refundCents: number
  netCents: number
  statusCounts: Record<string, number>
}

type GroupBreakdownRow = {
  groupId: number | null
  groupName: string
  groupOrderCount: number
  branchOrderCount: number
  branchCount: number
  quantityOrdered: number
  totalCents: number
  refundCents: number
  netCents: number
}

type ReportResponse = {
  items: ReportRow[]
  pagination: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean }
  summary: ReportSummary
}

type GroupViewResponse = {
  byGroup: GroupBreakdownRow[]
  summary: ReportSummary
}

export function GroupOrderReport() {
  const { toast } = useToast()
  const { data: session } = useSession()
  const organizationId = (session?.user as any)?.organizationId as number | undefined

  const [tab, setTab] = useState("orders")
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [referenceFilter, setReferenceFilter] = useState("")
  const debouncedReference = useDebounce(referenceFilter.trim(), 300)
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [status, setStatus] = useState<string>("ALL")
  const [dateRange, setDateRange] = useState<DateRange | null>(null)
  const [activePreset, setActivePreset] = useState<FilterPreset>("all")
  const [isExporting, setIsExporting] = useState(false)

  // One filter string shared by both views, so the group roll-up always
  // describes exactly the rows the list is showing.
  const filterQuery = useMemo(() => {
    const params = new URLSearchParams()
    if (debouncedReference) params.set("reference", debouncedReference)
    if (groupIds.length > 0) params.set("groupIds", groupIds.join(","))
    if (status !== "ALL") params.set("status", status)
    if (dateRange?.startDate) params.set("startDate", dateRange.startDate.toISOString())
    if (dateRange?.endDate) params.set("endDate", dateRange.endDate.toISOString())
    return params.toString()
  }, [debouncedReference, groupIds, status, dateRange])

  const {
    data: reportData,
    error: reportError,
    isLoading: isReportLoading,
    isValidating,
    mutate: mutateReport,
  } = useSWR<ReportResponse>(
    `/api/v1/group-portal/reports/group-orders?${filterQuery}&page=${page}&limit=${PAGE_SIZE}`,
    fetcher,
    { keepPreviousData: true },
  )

  const {
    data: groupData,
    isLoading: isGroupLoading,
    mutate: mutateGroups,
  } = useSWR<GroupViewResponse>(
    tab === "groups" ? `/api/v1/group-portal/reports/group-orders?${filterQuery}&view=groups` : null,
    fetcher,
    { keepPreviousData: true },
  )

  const items = reportData?.items ?? []
  const pagination = reportData?.pagination
  const summary = reportData?.summary ?? groupData?.summary
  const byGroup = useMemo(() => groupData?.byGroup ?? [], [groupData])

  const resetToFirstPage = useCallback(() => setPage(1), [])

  const toggleExpanded = useCallback((id: number) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleDateChange = useCallback(({ range, preset }: GlobalDateFilterChange) => {
    setDateRange(range)
    setActivePreset(preset)
    setPage(1)
  }, [])

  const resetFilters = useCallback(() => {
    setReferenceFilter("")
    setGroupIds([])
    setStatus("ALL")
    setDateRange(null)
    setActivePreset("all")
    setPage(1)
  }, [])

  /**
   * Walks the filtered set page by page so an export covers every matching
   * group order, not only the page on screen. Bounded so a very wide filter
   * cannot turn one click into an unbounded number of requests.
   */
  const fetchAllRows = useCallback(async (): Promise<ReportRow[]> => {
    const collected: ReportRow[] = []
    for (let current = 1; current <= EXPORT_PAGE_LIMIT; current += 1) {
      const payload = await fetcher<ReportResponse>(
        `/api/v1/group-portal/reports/group-orders?${filterQuery}&page=${current}&limit=${EXPORT_PAGE_SIZE}`,
      )
      const batch = payload?.items ?? []
      collected.push(...batch)
      if (batch.length === 0 || !payload?.pagination?.hasMore) break
    }
    return collected
  }, [filterQuery])

  const handleExport = useCallback(async (format: "csv" | "excel" | "pdf") => {
    if (isExporting) return
    setIsExporting(true)
    try {
      const isGroupView = tab === "groups"
      const headers = isGroupView
        ? ["Group", "Group orders", "Branch orders", "Branches", "Qty ordered", "Total", "Refunded", "Net"]
        : ["Group Order ID", "Date", "Group", "Requested by", "Branch orders", "Branches", "Qty ordered", "Total", "Refunded", "Net"]

      const rows = isGroupView
        ? byGroup.map((row) => [
          row.groupName,
          row.groupOrderCount,
          row.branchOrderCount,
          row.branchCount,
          formatQuantity(row.quantityOrdered),
          (row.totalCents / 100).toFixed(2),
          (row.refundCents / 100).toFixed(2),
          (row.netCents / 100).toFixed(2),
        ])
        : (await fetchAllRows()).map((row) => [
          row.reference,
          row.createdAt ? new Date(row.createdAt).toLocaleString() : "-",
          row.groupName,
          row.requestedByName,
          row.scopedOrderCount,
          row.branchCount,
          formatQuantity(row.quantityOrdered),
          (row.totalCents / 100).toFixed(2),
          (row.refundCents / 100).toFixed(2),
          (row.netCents / 100).toFixed(2),
        ])

      if (rows.length === 0) {
        toast({ title: "Nothing to export", description: "No group orders match the active filters." })
        return
      }

      const fileStem = `group-order-report-${Date.now()}`

      if (format === "pdf") {
        const doc = new jsPDF("landscape")
        doc.setFontSize(18)
        doc.text(isGroupView ? "Group Order Report — by group" : "Group Order Report", 14, 20)
        doc.setFontSize(10)
        doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 28)
        autoTable(doc, { startY: 38, head: [headers], body: rows, theme: "grid", styles: { fontSize: 8 } })
        doc.save(`${fileStem}.pdf`)
        return
      }

      const sheet = XLSX.utils.aoa_to_sheet([
        sanitizeSpreadsheetRow(headers),
        ...rows.map(sanitizeSpreadsheetRow),
      ])
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, "Group orders")
      XLSX.writeFile(book, `${fileStem}.${format === "excel" ? "xlsx" : "csv"}`)
    } catch (caught) {
      console.error("Group order report export failed", caught)
      toast({
        title: "Export failed",
        description: caught instanceof Error ? caught.message : "Unable to export the filtered group orders.",
        variant: "destructive",
      })
    } finally {
      setIsExporting(false)
    }
  }, [byGroup, fetchAllRows, isExporting, tab, toast])

  const refresh = useCallback(() => {
    void mutateReport()
    if (tab === "groups") void mutateGroups()
  }, [mutateGroups, mutateReport, tab])

  const hasActiveFilters = Boolean(debouncedReference) || groupIds.length > 0 || status !== "ALL" || Boolean(dateRange)

  return (
    <div className="space-y-6">
      <header className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)] dark:border-slate-800 dark:bg-slate-900 sm:flex-row sm:items-center">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-indigo-50/50 bg-gradient-to-tr from-indigo-100 to-violet-100 shadow-inner dark:border-indigo-800/50 dark:from-indigo-900/50 dark:to-violet-900/50">
            <Layers className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Group Order Report</h1>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Orders rolled up by group order ID and by group, across the branches assigned to you
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={isValidating}
            className="h-9 gap-2 rounded-xl text-xs font-semibold"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isValidating && "animate-spin")} />
            Refresh
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                disabled={isExporting}
                className="h-9 gap-2 rounded-xl bg-indigo-600 text-xs font-semibold text-white hover:bg-indigo-500"
              >
                {isExporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleExport("csv")}>
                <FileText className="mr-2 h-4 w-4" /> CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport("excel")}>
                <FileSpreadsheet className="mr-2 h-4 w-4" /> Excel
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport("pdf")}>
                <FileText className="mr-2 h-4 w-4" /> PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KPICard
          title="Group orders"
          value={summary?.groupOrderCount ?? 0}
          icon={Layers}
          colorScheme="indigo"
          isLoading={!summary}
          subtitle={`${summary?.branchOrderCount ?? 0} branch orders`}
        />
        <KPICard
          title="Branches ordered for"
          value={summary?.branchCount ?? 0}
          icon={Building2}
          colorScheme="blue"
          isLoading={!summary}
        />
        <KPICard
          title="Quantity ordered"
          value={formatQuantity(summary?.quantityOrdered ?? 0)}
          icon={Package}
          colorScheme="violet"
          isLoading={!summary}
        />
        <KPICard
          title="Net value"
          value={formatPKR((summary?.netCents ?? 0) / 100)}
          icon={Wallet}
          colorScheme="emerald"
          isLoading={!summary}
          comparisonLabel="Refunded"
          comparisonValue={formatPKR((summary?.refundCents ?? 0) / 100)}
        />
      </div>

      <Card className="rounded-2xl border-slate-200 dark:border-slate-800">
        <CardContent className="flex flex-wrap items-center gap-2 p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <Input
              value={referenceFilter}
              onChange={(event) => {
                setReferenceFilter(event.target.value)
                resetToFirstPage()
              }}
              placeholder="Group Order ID"
              aria-label="Filter by group order ID"
              className="h-10 w-52 rounded-xl pl-9 text-xs font-semibold"
            />
          </div>

          <GlobalDateFilter
            value={dateRange}
            onChange={handleDateChange}
            activePreset={activePreset}
            customRangeOnly
          />

          {organizationId ? (
            <GroupFilter
              selectedIds={groupIds}
              onChange={(ids) => {
                setGroupIds(ids)
                resetToFirstPage()
              }}
              organizationIds={[String(organizationId)]}
            />
          ) : null}

          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 p-1 dark:border-slate-800">
            {STATUS_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  setStatus(option.value)
                  resetToFirstPage()
                }}
                className={cn(
                  "rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition-colors",
                  status === option.value
                    ? "bg-indigo-600 text-white"
                    : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          {hasActiveFilters && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              className="h-10 rounded-xl text-xs font-semibold text-slate-500"
            >
              Clear filters
            </Button>
          )}
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="orders" className="gap-2">
            <Layers className="h-4 w-4" />
            By group order
          </TabsTrigger>
          <TabsTrigger value="groups" className="gap-2">
            <Building2 className="h-4 w-4" />
            By group
          </TabsTrigger>
        </TabsList>

        <TabsContent value="orders" className="mt-5 space-y-3">
          {reportError && (
            <Card className="rounded-2xl border-rose-200 dark:border-rose-900">
              <CardContent className="p-6 text-sm font-medium text-rose-600 dark:text-rose-400">
                {reportError instanceof Error ? reportError.message : "Unable to load the group order report."}
              </CardContent>
            </Card>
          )}

          {isReportLoading && !reportData && <ListSkeleton />}

          {!isReportLoading && items.length === 0 && !reportError && (
            <Card className="rounded-2xl border-slate-200 dark:border-slate-800">
              <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
                <Inbox className="h-8 w-8 text-slate-300" />
                <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">No group orders found</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  No group order in your assigned branches matches the active filters.
                </p>
              </CardContent>
            </Card>
          )}

          {items.map((row) => (
            <GroupOrderRowCard
              key={row.id}
              row={row}
              expanded={expanded.has(row.id)}
              onToggle={() => toggleExpanded(row.id)}
            />
          ))}

          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                Page {pagination.page} of {pagination.totalPages} · {pagination.total} group orders
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  className="h-8 gap-1 rounded-lg text-xs"
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!pagination.hasMore}
                  onClick={() => setPage((current) => current + 1)}
                  className="h-8 gap-1 rounded-lg text-xs"
                >
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="groups" className="mt-5">
          <Card className="overflow-hidden rounded-2xl border-slate-200 dark:border-slate-800">
            <CardContent className="p-0">
              {isGroupLoading && !groupData ? (
                <div className="p-6">
                  <ListSkeleton />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-[10px] font-black uppercase tracking-widest text-slate-500">Group</TableHead>
                        <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Group orders</TableHead>
                        <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Branch orders</TableHead>
                        <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Branches</TableHead>
                        <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Qty ordered</TableHead>
                        <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Total</TableHead>
                        <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Refunded</TableHead>
                        <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Net</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byGroup.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={8} className="py-10 text-center text-xs font-semibold text-slate-500">
                            No group orders match the active filters.
                          </TableCell>
                        </TableRow>
                      ) : (
                        byGroup.map((row) => (
                          <TableRow key={row.groupId ?? "unassigned"}>
                            <TableCell className="text-xs font-bold text-slate-800 dark:text-slate-200">{row.groupName}</TableCell>
                            <TableCell className="text-right text-xs tabular-nums">{row.groupOrderCount}</TableCell>
                            <TableCell className="text-right text-xs tabular-nums">{row.branchOrderCount}</TableCell>
                            <TableCell className="text-right text-xs tabular-nums">{row.branchCount}</TableCell>
                            <TableCell className="text-right text-xs tabular-nums">{formatQuantity(row.quantityOrdered)}</TableCell>
                            <TableCell className="text-right text-xs tabular-nums">{formatPKR(row.totalCents / 100)}</TableCell>
                            <TableCell className="text-right text-xs tabular-nums text-rose-600 dark:text-rose-400">{formatPKR(row.refundCents / 100)}</TableCell>
                            <TableCell className="text-right text-xs font-bold tabular-nums">{formatPKR(row.netCents / 100)}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function GroupOrderRowCard({
  row,
  expanded,
  onToggle,
}: Readonly<{ row: ReportRow; expanded: boolean; onToggle: () => void }>) {
  return (
    <Card className="overflow-hidden rounded-2xl border-slate-200 dark:border-slate-800">
      <CardContent className="p-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex w-full flex-col gap-3 p-4 text-left lg:flex-row lg:items-center lg:justify-between"
        >
          <span className="flex min-w-0 flex-1 items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-400">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </span>
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-bold text-slate-900 dark:text-slate-100">{row.reference}</span>
                <Badge variant="secondary" className="gap-1 rounded-full text-[10px]">
                  <Layers className="h-3 w-3" />
                  {row.groupName}
                </Badge>
                {Object.entries(row.statusCounts).map(([statusKey, statusCount]) => (
                  <Badge
                    key={statusKey}
                    className={cn("rounded-full text-[10px] font-bold", STATUS_STYLES[statusKey] ?? STATUS_STYLES.PENDING)}
                  >
                    {statusCount} {statusKey.toLowerCase()}
                  </Badge>
                ))}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                <span>{formatDateTime(row.createdAt)}</span>
                <span>Requested by {row.requestedByName}</span>
                <span>
                  {row.scopedOrderCount} branch order{row.scopedOrderCount === 1 ? "" : "s"} in your scope
                </span>
                <span>{formatQuantity(row.quantityOrdered)} units ordered</span>
              </span>
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-start gap-0.5 lg:items-end">
            <span className="text-sm font-black text-slate-900 dark:text-slate-100">{formatPKR(row.netCents / 100)}</span>
            {row.refundCents > 0 && (
              <span className="text-[10px] font-bold uppercase tracking-widest text-rose-500">
                {formatPKR(row.refundCents / 100)} refunded
              </span>
            )}
          </span>
        </button>

        {expanded && (
          <div className="overflow-x-auto border-t border-slate-100 dark:border-slate-800">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[10px] font-black uppercase tracking-widest text-slate-500">Branch</TableHead>
                  <TableHead className="text-[10px] font-black uppercase tracking-widest text-slate-500">Transaction ID</TableHead>
                  <TableHead className="text-[10px] font-black uppercase tracking-widest text-slate-500">Status</TableHead>
                  <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Items</TableHead>
                  <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Qty</TableHead>
                  <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Total</TableHead>
                  <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Refunded</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {row.orders.map((child) => (
                  <TableRow key={child.id}>
                    <TableCell className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                      {child.branchName}
                      {child.branchCostCenterId && (
                        <span className="ml-1 font-mono text-[10px] text-slate-400">{child.branchCostCenterId}</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-slate-500">{child.tid}</TableCell>
                    <TableCell>
                      <Badge
                        className={cn(
                          "rounded-full text-[10px] font-bold",
                          STATUS_STYLES[String(child.status).toUpperCase()] ?? STATUS_STYLES.PENDING,
                        )}
                      >
                        {String(child.status).toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{child.itemCount}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{formatQuantity(child.quantityOrdered)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{formatPKR(child.totalCents / 100)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-rose-600 dark:text-rose-400">
                      {child.refundCents > 0 ? formatPKR(child.refundCents / 100) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {expanded && row.notes && (
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <span className="font-semibold">Requester notes:</span> {row.notes}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
