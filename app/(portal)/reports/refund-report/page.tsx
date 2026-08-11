"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useSession } from "next-auth/react"
import useSWR from "swr"
import jsPDF from "jspdf"
import autoTable from "jspdf-autotable"
import * as XLSX from "xlsx"
import {
    Calendar,
    CheckCircle2,
    ChevronLeft,
    ChevronRight,
    Clock3,
    Download,
    FileSpreadsheet,
    FileText,
    Hash,
    Loader2,
    PackageOpen,
    ReceiptText,
    RefreshCw,
    RotateCcw,
    Search,
    Store,
    XCircle,
} from "lucide-react"

import { useAppContext } from "@/components/context/app-context"
import { GlobalDateFilter, type FilterPreset,type GlobalDateFilterChange } from "@/components/dashboard/global-date-filter"
import { BranchFilter } from "@/components/reports/branch-filter"
import { ColumnSelector, type ColumnDef, useColumnSelector } from "@/components/reports/column-selector"
import { RefundDetailsDrawer } from "@/components/reports/refund-details-drawer"
import { GroupFilter } from "@/components/reports/group-filter"
import { KPICard } from "@/components/reports/kpi-card"
import { MultiSelectFilter } from "@/components/reports/multi-select-filter"
import { OrganizationFilter } from "@/components/reports/organization-filter"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Pagination, PaginationContent, PaginationItem } from "@/components/ui/pagination"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useDebounce } from "@/hooks/use-debounce"
import { useToast } from "@/hooks/use-toast"
import type { DateRange } from "@/lib/hooks/use-sales-performance"
import { formatQuantity } from "@/lib/quantity"
import { sanitizeSpreadsheetRow } from "@/lib/spreadsheet"
import { cn, formatPKR } from "@/lib/utils"

const PAGE_SIZE = 25

const ALL_COLUMNS: ColumnDef[] = [
    { key: "refundNumber", label: "Refund #", defaultVisible: true },
    { key: "refundDate", label: "Refund Date", defaultVisible: true },
    { key: "tid", label: "Order ID", defaultVisible: true },
    { key: "reason", label: "Refund Reason", defaultVisible: true },
    { key: "requestedBy", label: "Requested By", defaultVisible: true },
    { key: "organization", label: "Organization", defaultVisible: true },
    { key: "group", label: "Group", defaultVisible: true },
    { key: "branch", label: "Branch", defaultVisible: true },
    { key: "status", label: "Status", defaultVisible: true },
    { key: "refundType", label: "Type", defaultVisible: true },
    { key: "quantity", label: "Qty Refunded", defaultVisible: true },
    { key: "amount", label: "Refund Amount", defaultVisible: true },
    { key: "processedBy", label: "Processed By", defaultVisible: false },
]

type RefundStatus = "all" | "pending" | "approved" | "completed" | "cancelled" | "superseded"

interface RefundLine {
    refundId: number
    orderItemId: number
    productName: string
    productCode: string | null
    unit: string
    quantity: number
    amountCents: number | null
}

interface RefundRecord {
    id: number
    refundNumber: string
    amountCents: number | null
    taxRefundCents: number | null
    itemRefundCents: number | null
    reason: string | null
    status: string
    refundType: "FULL" | "PARTIAL"
    createdAt: string
    updatedAt: string
    orderId: number
    tid: string
    orderStatus: string
    statusAtRefund: string | null
    paymentStatus: string
    orderCreatedAt: string
    orderTotalCents: number | null
    organizationId: number | null
    organizationName: string | null
    groupId: number | null
    groupName: string | null
    branchId: number
    branchName: string | null
    requestedByName: string | null
    requestedByEmail: string | null
    requestedByEmployeeId: string | null
    processedByName: string | null
    processedByEmail: string | null
    quantityRefunded: number
    itemCount: number
    items: RefundLine[]
}

interface RefundReportResponse {
    items: RefundRecord[]
    summary: {
        totalRefunds: number
        approvedRefunds: number
        pendingRefunds: number
        cancelledRefunds: number
        approvedAmountCents: number | null
        pendingAmountCents: number | null
    }
    pagination: {
        page: number
        limit: number
        total: number
        totalPages: number
        hasMore: boolean
    }
    pricesHidden: boolean
}

const fetcher = async (url: string): Promise<RefundReportResponse> => {
    const response = await fetch(url)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || "Unable to load the refund report")
    return data
}

const money = (cents: number | null | undefined) => formatPKR(Number(cents || 0) / 100)

const statusStyles: Record<string, string> = {
    PENDING: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    APPROVED: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    COMPLETED: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
    CANCELLED: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300",
    SUPERSEDED: "border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
}

const StatusBadge = ({ status }: { status: string }) => (
    <Badge
        variant="outline"
        className={cn(
            "whitespace-nowrap rounded-xl px-2.5 py-1 text-[9px] font-black uppercase tracking-wider",
            statusStyles[status.toUpperCase()] || "border-slate-200 bg-slate-50 text-slate-600",
        )}
    >
        {status}
    </Badge>
)

function addRefundScopeParams(params: URLSearchParams, options: {
    role: string | undefined
    contextBranchId: string | null
    sessionBranchId: number | null
    organizationId: string | number | null
    organizationIds: string[]
    groupIds: string[]
    branchIds: string[]
}): void {
    const { role, contextBranchId, sessionBranchId, organizationId, organizationIds, groupIds, branchIds } = options
    if (["BRANCH_ADMIN", "BRANCH_MANAGER"].includes(role ?? "")) {
        const branchId = contextBranchId || sessionBranchId
        if (organizationId) params.set("organizationId", String(organizationId))
        if (branchId) params.set("branchIds", String(branchId))
        return
    }
    if (organizationIds.length > 0) params.set("organizationIds", organizationIds.join(","))
    else if (organizationId) params.set("organizationId", String(organizationId))
    if (groupIds.length > 0) params.set("groupIds", groupIds.join(","))
    if (branchIds.length > 0) params.set("branchIds", branchIds.join(","))
}

function buildRefundQueryParams(options: Parameters<typeof addRefundScopeParams>[1] & {
    dateRange: DateRange | null
    statusFilter: RefundStatus
    typeFilter: string[]
    search: string
}): URLSearchParams {
    const params = new URLSearchParams()
    addRefundScopeParams(params, options)
    if (options.dateRange?.startDate) params.set("startDate", options.dateRange.startDate.toISOString())
    if (options.dateRange?.endDate) params.set("endDate", options.dateRange.endDate.toISOString())
    if (options.statusFilter !== "all") params.set("status", options.statusFilter)
    if (options.typeFilter[0]) params.set("refundType", options.typeFilter[0])
    if (options.search) params.set("q", options.search)
    return params
}

export default function RefundReportPage() {
    const { data: session, status: sessionStatus } = useSession()
    const { toast } = useToast()
    const {
        organizationId: contextOrganizationId,
        branchId: contextBranchId,
        isInitialized,
    } = useAppContext()

    const role = String((session?.user as any)?.role || "")
    const userOrganizationId = (session?.user as any)?.organizationId
    const organizationId = userOrganizationId || contextOrganizationId
    const [search, setSearch] = useState("")
    const debouncedSearch = useDebounce(search.trim(), 300)
    const [statusFilter, setStatusFilter] = useState<RefundStatus>("all")
    const [typeFilter, setTypeFilter] = useState<string[]>([])
    const [dateRange, setDateRange] = useState<DateRange | null>(null)
    const [activePreset, setActivePreset] = useState<FilterPreset>("all")
    const [organizationIds, setOrganizationIds] = useState<string[]>([])
    const [groupIds, setGroupIds] = useState<string[]>([])
    const [branchIds, setBranchIds] = useState<string[]>([])
    const [currentPage, setCurrentPage] = useState(1)
    const [selectedRefund, setSelectedRefund] = useState<RefundRecord | null>(null)
    const [drawerOpen, setDrawerOpen] = useState(false)
    const [isExporting, setIsExporting] = useState(false)
    const [generatedAt, setGeneratedAt] = useState("")
    const { visibleKeys, isVisible, setVisibleKeys } = useColumnSelector(ALL_COLUMNS, "refund-report-v2")

    useEffect(() => setGeneratedAt(new Date().toLocaleString()), [])

    const queryParams = useMemo(() => buildRefundQueryParams({
        role,
        contextBranchId,
        sessionBranchId: (session?.user as any)?.branchId ?? null,
        organizationId,
        organizationIds,
        groupIds,
        branchIds,
        dateRange,
        statusFilter,
        typeFilter,
        search: debouncedSearch,
    }), [
        branchIds,
        contextBranchId,
        dateRange,
        debouncedSearch,
        groupIds,
        organizationId,
        organizationIds,
        role,
        session,
        statusFilter,
        typeFilter,
    ])

    const pagedParams = useMemo(() => {
        const params = new URLSearchParams(queryParams)
        params.set("page", String(currentPage))
        params.set("limit", String(PAGE_SIZE))
        return params
    }, [currentPage, queryParams])

    const { data, error, isLoading, isValidating, mutate } = useSWR(
        isInitialized && sessionStatus === "authenticated"
            ? `/api/v1/analytics/refunds?${pagedParams.toString()}`
            : null,
        fetcher,
        { keepPreviousData: true },
    )

    useEffect(() => {
        setCurrentPage(1)
    }, [queryParams])

    const totalPages = Math.max(1, Number(data?.pagination?.totalPages || 1))
    const total = Number(data?.pagination?.total || 0)
    const firstVisible = total === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1
    const lastVisible = Math.min((currentPage - 1) * PAGE_SIZE + Number(data?.items?.length || 0), total)
    const pricesHidden = Boolean(data?.pricesHidden)
    const summary = data?.summary

    useEffect(() => {
        if (currentPage > totalPages) setCurrentPage(totalPages)
    }, [currentPage, totalPages])

    const handleDateChange = useCallback(({ range, preset }: GlobalDateFilterChange) => {
        setDateRange(range)
        setActivePreset(preset)
    }, [])

    const resetFilters = useCallback(() => {
        setSearch("")
        setStatusFilter("all")
        setTypeFilter([])
        setDateRange(null)
        setActivePreset("all")
        setOrganizationIds([])
        setGroupIds([])
        setBranchIds([])
        setCurrentPage(1)
    }, [])

    const openDetails = useCallback((refund: RefundRecord) => {
        setSelectedRefund(refund)
        setDrawerOpen(true)
    }, [])

    const fetchAllRefunds = useCallback(async () => {
        const params = new URLSearchParams(queryParams)
        params.set("page", "1")
        params.set("limit", "100")
        const firstPage = await fetcher(`/api/v1/analytics/refunds?${params.toString()}`)
        const records = [...firstPage.items]
        const pages = Math.max(1, Number(firstPage.pagination.totalPages || 1))
        for (let page = 2; page <= pages; page += 4) {
            const pageNumbers = Array.from(
                { length: Math.min(4, pages - page + 1) },
                (_, index) => page + index,
            )
            const pageData = await Promise.all(pageNumbers.map(async (pageNumber) => {
                const pageParams = new URLSearchParams(params)
                pageParams.set("page", String(pageNumber))
                return fetcher(`/api/v1/analytics/refunds?${pageParams.toString()}`)
            }))
            pageData.forEach((result) => records.push(...result.items))
        }
        return records
    }, [queryParams])

    const exportReport = useCallback(async (format: "csv" | "excel" | "pdf") => {
        if (isExporting) return
        setIsExporting(true)
        try {
            const records = await fetchAllRefunds()
            if (records.length === 0) {
                toast({ title: "No refunds to export", description: "No refunds match the active filters." })
                return
            }

            const headers = [
                "Refund Number", "Refund Date", "Order ID", "Requested By", "Employee #",
                "Organization", "Group", "Branch", "Status", "Type", "Quantity", "Items",
                ...(pricesHidden ? [] : ["Item Refund (PKR)", "Tax Refund (PKR)", "Total Refund (PKR)", "Order Total (PKR)"]),
                "Reason", "Processed By",
            ]
            const rows = records.map((refund) => [
                refund.refundNumber,
                new Date(refund.createdAt).toLocaleString(),
                refund.tid,
                refund.requestedByName || refund.requestedByEmail || "System",
                refund.requestedByEmployeeId || "-",
                refund.organizationName || "-",
                refund.groupName || "-",
                refund.branchName || "-",
                refund.status,
                refund.refundType,
                refund.quantityRefunded,
                refund.items.map((item) => `${item.productName} (${formatQuantity(item.quantity)} ${item.unit})`).join("; ") || "-",
                ...(pricesHidden ? [] : [
                    (Number(refund.itemRefundCents || 0) / 100).toFixed(2),
                    (Number(refund.taxRefundCents || 0) / 100).toFixed(2),
                    (Number(refund.amountCents || 0) / 100).toFixed(2),
                    (Number(refund.orderTotalCents || 0) / 100).toFixed(2),
                ]),
                refund.reason || "-",
                refund.processedByName || refund.processedByEmail || "-",
            ])

            if (format === "pdf") {
                const doc = new jsPDF("landscape")
                doc.setFontSize(18)
                doc.text("Refund Report", 14, 18)
                doc.setFontSize(9)
                doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 25)
                autoTable(doc, {
                    startY: 32,
                    head: [headers],
                    body: rows,
                    theme: "grid",
                    styles: { fontSize: 6 },
                })
                doc.save(`refund-report-${Date.now()}.pdf`)
                return
            }

            const worksheet = XLSX.utils.aoa_to_sheet([
                sanitizeSpreadsheetRow(headers),
                ...rows.map(sanitizeSpreadsheetRow),
            ])
            const workbook = XLSX.utils.book_new()
            XLSX.utils.book_append_sheet(workbook, worksheet, "Refunds")
            XLSX.writeFile(workbook, `refund-report-${Date.now()}.${format === "excel" ? "xlsx" : "csv"}`)
        } catch (exportError) {
            toast({
                title: "Export failed",
                description: exportError instanceof Error ? exportError.message : "The report could not be exported.",
                variant: "destructive",
            })
        } finally {
            setIsExporting(false)
        }
    }, [fetchAllRefunds, isExporting, pricesHidden, toast])

    if (sessionStatus === "loading" || !isInitialized || (role === "BRANCH_ADMIN" && !data && !error)) {
        return <div className="flex h-[50vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-indigo-400" /></div>
    }

    return (
        <div className="min-h-screen min-w-0 overflow-x-hidden bg-[#f8fafc] pb-20 transition-colors duration-500 dark:bg-[#020617]">
            <div className="sticky top-0 z-40 w-full border-b border-slate-200/60 bg-white/70 shadow-[0_1px_20px_rgba(0,0,0,0.02)] backdrop-blur-3xl dark:border-slate-800/60 dark:bg-slate-950/70">
                <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-6 px-6 py-4">
                    <div className="group flex items-center gap-5">
                        <div className="relative">
                            <div className="absolute -inset-1 rounded-2xl bg-gradient-to-tr from-rose-500 to-orange-500 opacity-20 blur transition group-hover:opacity-40" />
                            <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-rose-500 to-orange-600 shadow-lg shadow-rose-500/20 transition-transform group-hover:rotate-6">
                                <RotateCcw className="h-6 w-6 text-white" />
                            </div>
                        </div>
                        <div>
                            <h1 className="mb-1 text-xl font-black uppercase leading-none tracking-tighter text-slate-900 dark:text-white">Refund Intelligence</h1>
                            <div className="flex items-center gap-1.5">
                                <span className="h-1 w-1 animate-pulse rounded-full bg-rose-500" />
                                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">Refund audit & reporting</p>
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="hidden rounded-2xl border border-slate-200 bg-slate-100 p-1.5 shadow-inner dark:border-slate-800 dark:bg-slate-900 lg:block">
                            <GlobalDateFilter value={dateRange} onChange={handleDateChange} activePreset={activePreset} />
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="rounded-xl text-slate-400 hover:text-rose-500"
                            onClick={() => mutate()}
                            aria-label="Refresh refund report"
                        >
                            <RefreshCw className={cn("h-4 w-4", isValidating && "animate-spin")} />
                        </Button>
                    </div>
                </div>
            </div>

            <main className="mx-auto w-full min-w-0 max-w-[1600px] space-y-8 px-6 pt-10">
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
                    <KPICard title="Refund Requests" value={Number(summary?.totalRefunds || 0).toLocaleString()} icon={ReceiptText} colorScheme="blue" isLoading={!data} />
                    {!pricesHidden ? (
                        <KPICard title="Approved Value" value={money(summary?.approvedAmountCents)} icon={CheckCircle2} colorScheme="emerald" isLoading={!data} />
                    ) : (
                        <KPICard title="Approved Refunds" value={Number(summary?.approvedRefunds || 0).toLocaleString()} icon={CheckCircle2} colorScheme="emerald" isLoading={!data} />
                    )}
                    <KPICard
                        title="Pending Review"
                        value={Number(summary?.pendingRefunds || 0).toLocaleString()}
                        subtitle={!pricesHidden && summary ? `${money(summary.pendingAmountCents)} pending` : undefined}
                        icon={Clock3}
                        colorScheme="amber"
                        isLoading={!data}
                    />
                    <KPICard title="Cancelled" value={Number(summary?.cancelledRefunds || 0).toLocaleString()} icon={XCircle} colorScheme="rose" isLoading={!data} />
                </div>

                <section className="space-y-6">
                    <div className="flex flex-col justify-between gap-5 rounded-[2rem] border border-slate-200/60 bg-white p-5 shadow-sm dark:border-slate-800/60 dark:bg-slate-900/40 xl:flex-row xl:items-center">
                        <div className="flex max-w-full flex-wrap items-center gap-2 rounded-[1.25rem] border border-slate-100 bg-slate-50 p-1 dark:border-slate-800/50 dark:bg-slate-950/50">
                            {(["all", "pending", "approved", "completed", "cancelled", "superseded"] as RefundStatus[]).map((status) => (
                                <button type="button"
                                    key={status}
                                    onClick={() => setStatusFilter(status)}
                                    className={cn(
                                        "rounded-xl px-4 py-2 text-[10px] font-black uppercase tracking-widest transition-all",
                                        statusFilter === status
                                            ? "bg-white text-indigo-600 shadow-md ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700"
                                            : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200",
                                    )}
                                >
                                    {status === "all" ? "All" : status}
                                </button>
                            ))}
                        </div>

                        <div className="flex flex-wrap items-center gap-3">
                            <div className="relative">
                                <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                                <Input
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                    placeholder="Search refund, order or person..."
                                    className="h-11 w-[300px] rounded-2xl border-transparent bg-slate-100 pl-11 text-[11px] font-bold dark:bg-slate-800/80"
                                />
                            </div>
                            <div className="lg:hidden">
                                <GlobalDateFilter value={dateRange} onChange={handleDateChange} activePreset={activePreset} />
                            </div>
                            <MultiSelectFilter
                                title="Refund Type"
                                items={[{ id: "FULL", label: "Full Refund" }, { id: "PARTIAL", label: "Partial Refund" }]}
                                selectedIds={typeFilter}
                                onChange={setTypeFilter}
                                placeholder="All Refund Types"
                                showSearch={false}
                                maxSelect={1}
                                icon={<PackageOpen className="h-4 w-4 text-rose-500" />}
                            />
                            {role === "SUPER_ADMIN" && (
                                <OrganizationFilter
                                    selectedIds={organizationIds}
                                    onChange={(ids) => {
                                        setOrganizationIds(ids)
                                        setGroupIds([])
                                        setBranchIds([])
                                    }}
                                />
                            )}
                            {role !== "BRANCH_ADMIN" && role !== "BRANCH_MANAGER" && (
                                <>
                                    <GroupFilter
                                        selectedIds={groupIds}
                                        onChange={(ids) => {
                                            setGroupIds(ids)
                                            setBranchIds([])
                                        }}
                                        organizationIds={(() => {
                                          if (organizationIds.length > 0) {
                                            return organizationIds
                                          }
                                          return (organizationId ? [String(organizationId)] : undefined)
                                        })()}
                                    />
                                    <BranchFilter
                                        selectedIds={branchIds}
                                        onChange={setBranchIds}
                                        organizationIds={(() => {
                                          if (organizationIds.length > 0) {
                                            return organizationIds
                                          }
                                          return (organizationId ? [organizationId] : undefined)
                                        })()}
                                        groupIds={groupIds}
                                    />
                                </>
                            )}
                            <ColumnSelector columns={ALL_COLUMNS} storageKey="refund-report-v2" visibleKeys={visibleKeys} onChange={setVisibleKeys} />
                            <Button variant="outline" size="icon" onClick={resetFilters} className="h-11 w-11 rounded-xl" aria-label="Reset refund filters" title="Reset refund filters">
                                <RotateCcw className="h-4 w-4" />
                            </Button>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="outline" disabled={isExporting || total === 0} className="h-11 gap-2 rounded-xl px-5 text-[11px] font-black">
                                        {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                                        Export
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-52 rounded-2xl p-2">
                                    <DropdownMenuItem onClick={() => exportReport("csv")} className="cursor-pointer rounded-xl py-3 text-xs font-bold"><FileText className="mr-3 h-4 w-4" /> CSV Archive</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => exportReport("excel")} className="cursor-pointer rounded-xl py-3 text-xs font-bold"><FileSpreadsheet className="mr-3 h-4 w-4 text-emerald-500" /> Excel Workbook</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => exportReport("pdf")} className="cursor-pointer rounded-xl py-3 text-xs font-bold"><FileText className="mr-3 h-4 w-4 text-rose-500" /> PDF Document</DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    </div>

                    <Card className="flex min-h-[600px] min-w-0 flex-col overflow-hidden rounded-[2.5rem] border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900/40">
                        <div className="min-w-0 flex-1 overflow-hidden [&_[data-slot=table-container]]:overflow-x-auto">
                            <Table className="min-w-[1950px] table-fixed">
                                <TableHeader>
                                    <TableRow className="border-b border-slate-200 bg-slate-50/80 hover:bg-slate-50/80 dark:border-slate-800 dark:bg-slate-900/80">
                                        {isVisible("refundNumber") && <TableHead className="h-14 w-[170px] px-4 text-[10px] font-black uppercase tracking-widest text-slate-500"><span className="flex items-center gap-2"><Hash className="h-3.5 w-3.5 text-rose-500" /> Refund #</span></TableHead>}
                                        {isVisible("refundDate") && <TableHead className="h-14 w-[135px] px-4 text-[10px] font-black uppercase tracking-widest text-slate-500"><span className="flex items-center gap-2"><Calendar className="h-3.5 w-3.5" /> Date</span></TableHead>}
                                        {isVisible("tid") && <TableHead className="h-14 w-[180px] px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">Order ID</TableHead>}
                                        {isVisible("reason") && <TableHead className="h-14 w-[300px] px-4 text-[10px] font-black uppercase tracking-widest text-rose-600 dark:text-rose-400">Refund Reason</TableHead>}
                                        {isVisible("requestedBy") && <TableHead className="h-14 w-[170px] px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">Requested By</TableHead>}
                                        {isVisible("organization") && role === "SUPER_ADMIN" && <TableHead className="h-14 w-[150px] px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">Organization</TableHead>}
                                        {isVisible("group") && role !== "BRANCH_ADMIN" && role !== "BRANCH_MANAGER" && <TableHead className="h-14 w-[140px] px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">Group</TableHead>}
                                        {isVisible("branch") && role !== "BRANCH_ADMIN" && role !== "BRANCH_MANAGER" && <TableHead className="h-14 w-[150px] px-4 text-[10px] font-black uppercase tracking-widest text-slate-500"><span className="flex items-center gap-2"><Store className="h-3.5 w-3.5" /> Branch</span></TableHead>}
                                        {isVisible("status") && <TableHead className="h-14 w-[120px] px-3 text-center text-[10px] font-black uppercase tracking-widest text-slate-500">Status</TableHead>}
                                        {isVisible("refundType") && <TableHead className="h-14 w-[115px] px-3 text-center text-[10px] font-black uppercase tracking-widest text-slate-500">Type</TableHead>}
                                        {isVisible("quantity") && <TableHead className="h-14 w-[100px] px-3 text-center text-[10px] font-black uppercase tracking-widest text-slate-500">Qty</TableHead>}
                                        {!pricesHidden && isVisible("amount") && <TableHead className="h-14 w-[145px] px-4 text-right text-[10px] font-black uppercase tracking-widest text-rose-500">Refund Amount</TableHead>}
                                        {isVisible("processedBy") && <TableHead className="h-14 w-[160px] px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">Processed By</TableHead>}
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {(() => {
                                      if (isLoading) {
                                        return (
                                        <TableRow><TableCell colSpan={ALL_COLUMNS.length} className="h-72 text-center"><Loader2 className="mx-auto h-8 w-8 animate-spin text-rose-400" /></TableCell></TableRow>
                                    )
                                      }
                                      if (error) {
                                        return (
                                        <TableRow><TableCell colSpan={ALL_COLUMNS.length} className="h-72 text-center"><p className="font-bold text-rose-500">{error.message}</p><Button variant="outline" className="mt-4 rounded-xl" onClick={() => mutate()}>Try again</Button></TableCell></TableRow>
                                    )
                                      }
                                      if (!data?.items?.length) {
                                        return (
                                        <TableRow><TableCell colSpan={ALL_COLUMNS.length} className="h-72 text-center"><ReceiptText className="mx-auto mb-4 h-10 w-10 text-slate-300" /><p className="text-xs font-black uppercase tracking-widest text-slate-400">No refunds match these filters</p></TableCell></TableRow>
                                    )
                                      }
                                      return data.items.map((refund) => (
                                        <TableRow
                                            key={refund.id}
                                            tabIndex={0}
                                            role="button"
                                            aria-label={`View details for ${refund.refundNumber}`}
                                            onClick={() => openDetails(refund)}
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter" || event.key === " ") {
                                                    event.preventDefault()
                                                    openDetails(refund)
                                                }
                                            }}
                                            className="group cursor-pointer border-b border-slate-100 transition-colors hover:bg-rose-50/40 focus-visible:bg-rose-50/60 focus-visible:outline-none dark:border-slate-800/50 dark:hover:bg-rose-500/5"
                                        >
                                            {isVisible("refundNumber") && <TableCell className="px-4 py-5"><p className="break-all font-mono text-[11px] font-black text-slate-900 dark:text-white">{refund.refundNumber}</p><p className="mt-1 text-[9px] font-bold uppercase tracking-wider text-rose-400">View details</p></TableCell>}
                                            {isVisible("refundDate") && <TableCell className="px-4 py-5" suppressHydrationWarning><p className="text-[11px] font-black text-slate-700 dark:text-slate-200">{new Date(refund.createdAt).toLocaleDateString()}</p><p className="mt-1 text-[9px] font-bold text-slate-400">{new Date(refund.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p></TableCell>}
                                            {isVisible("tid") && <TableCell className="px-4 py-5"><p className="break-all font-mono text-[11px] font-black text-indigo-600 dark:text-indigo-400">{refund.tid}</p></TableCell>}
                                            {isVisible("reason") && (
                                                <TableCell className="px-4 py-4">
                                                    <div className="rounded-xl border border-rose-100 bg-rose-50/70 px-3 py-2.5 dark:border-rose-900/50 dark:bg-rose-950/25">
                                                        <p className="whitespace-normal break-words text-[11px] font-bold leading-relaxed text-slate-700 dark:text-slate-200">
                                                            {refund.reason || "No reason was recorded for this refund."}
                                                        </p>
                                                    </div>
                                                </TableCell>
                                            )}
                                            {isVisible("requestedBy") && <TableCell className="px-4 py-5"><p className="break-words text-[11px] font-black text-slate-800 dark:text-slate-200">{refund.requestedByName || refund.requestedByEmail || "System"}</p><p className="mt-1 text-[9px] font-bold text-slate-400">{refund.requestedByEmployeeId ? `#${refund.requestedByEmployeeId}` : "No employee #"}</p></TableCell>}
                                            {isVisible("organization") && role === "SUPER_ADMIN" && <TableCell className="px-4 py-5 text-[10px] font-bold uppercase text-slate-500">{refund.organizationName || "-"}</TableCell>}
                                            {isVisible("group") && role !== "BRANCH_ADMIN" && role !== "BRANCH_MANAGER" && <TableCell className="px-4 py-5 text-[10px] font-black uppercase text-indigo-600 dark:text-indigo-400">{refund.groupName || "-"}</TableCell>}
                                            {isVisible("branch") && role !== "BRANCH_ADMIN" && role !== "BRANCH_MANAGER" && <TableCell className="px-4 py-5 text-[11px] font-black uppercase text-slate-700 dark:text-slate-300">{refund.branchName || "-"}</TableCell>}
                                            {isVisible("status") && <TableCell className="px-3 py-5 text-center"><StatusBadge status={refund.status} /></TableCell>}
                                            {isVisible("refundType") && <TableCell className="px-3 py-5 text-center"><Badge variant="outline" className={cn("rounded-xl px-2 py-1 text-[9px] font-black uppercase", refund.refundType === "FULL" ? "border-rose-200 text-rose-600" : "border-violet-200 text-violet-600")}>{refund.refundType}</Badge></TableCell>}
                                            {isVisible("quantity") && <TableCell className="px-3 py-5 text-center font-mono text-xs font-black text-slate-900 dark:text-white">{formatQuantity(refund.quantityRefunded)}</TableCell>}
                                            {!pricesHidden && isVisible("amount") && <TableCell className="px-4 py-5 text-right font-mono text-xs font-black text-rose-500">-{money(refund.amountCents)}</TableCell>}
                                            {isVisible("processedBy") && <TableCell className="px-4 py-5 text-[11px] font-bold text-slate-600 dark:text-slate-300">{refund.processedByName || refund.processedByEmail || "-"}</TableCell>}
                                        </TableRow>
                                    ))
                                    })()}
                                </TableBody>
                            </Table>
                        </div>

                        <div className="flex flex-col gap-4 border-t border-slate-100 bg-slate-50/50 px-6 py-5 dark:border-slate-900 dark:bg-slate-900/40 sm:flex-row sm:items-center sm:justify-between sm:px-8">
                            <div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">System generated audit • {generatedAt}</p>
                                <p className="mt-1 text-xs font-semibold text-slate-500">Showing {firstVisible}-{lastVisible} of {total.toLocaleString()} refunds</p>
                            </div>
                            <Pagination className="mx-0 w-auto justify-end">
                                <PaginationContent>
                                    <PaginationItem>
                                        <Button variant="outline" size="sm" className="gap-1 rounded-xl" disabled={currentPage <= 1 || isValidating} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}>
                                            <ChevronLeft className="h-4 w-4" /> <span className="hidden sm:inline">Previous</span>
                                        </Button>
                                    </PaginationItem>
                                    <PaginationItem><span className="flex h-9 min-w-24 items-center justify-center px-3 text-xs font-semibold text-slate-600 dark:text-slate-300">Page {currentPage} of {totalPages}</span></PaginationItem>
                                    <PaginationItem>
                                        <Button variant="outline" size="sm" className="gap-1 rounded-xl" disabled={currentPage >= totalPages || total === 0 || isValidating} onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}>
                                            <span className="hidden sm:inline">Next</span> <ChevronRight className="h-4 w-4" />
                                        </Button>
                                    </PaginationItem>
                                </PaginationContent>
                            </Pagination>
                        </div>
                    </Card>
                </section>
            </main>

            <RefundDetailsDrawer
                open={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                refund={selectedRefund}
                pricesHidden={pricesHidden}
            />
        </div>
    )
}
