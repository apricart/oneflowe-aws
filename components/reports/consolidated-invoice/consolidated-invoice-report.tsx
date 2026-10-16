"use client"

import { viewerAccessFor } from "@/lib/viewer-access"
import { useCallback, useEffect, useMemo, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useSession } from "next-auth/react"
import useSWR from "swr"
import { Download, FileText, Loader2 } from "lucide-react"

import { useAppContext } from "@/components/context/app-context"
import { BranchFilter } from "@/components/reports/branch-filter"
import { GroupFilter } from "@/components/reports/group-filter"
import { useTableSort } from "@/components/reports/sortable-header"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { canReadConsolidatedInvoiceReport, choosesOrganization } from "@/lib/consolidated-invoice-access"
import { karachiToday, type ConsolidatedInvoiceMode } from "@/lib/consolidated-invoice"
import { CONSOLIDATED_INVOICE_SORT_KEYS, type ConsolidatedInvoiceSortKey } from "@/lib/list-sort-keys"
import { PAYMENT_STATUSES, PAYMENT_STATUS_LABELS, type PaymentStatus } from "@/lib/payment-status"
import { safeFilenamePart } from "@/lib/security"
import type { SortState } from "@/lib/table-sort"

import { ConsolidatedInvoiceDocument, type ConsolidatedInvoiceResponse } from "./consolidated-invoice-document"

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const FIRST_YEAR = 2025

class ReportRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function fetchReport(url: string): Promise<ConsolidatedInvoiceResponse> {
  const response = await fetch(url)
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new ReportRequestError(body?.error || "The report could not be loaded", response.status)
  return body
}

type PeriodKind = "month" | "range"
type PaymentFilter = PaymentStatus | "ALL"

function readInitialPaymentFilter(value: string | null): PaymentFilter {
  return (PAYMENT_STATUSES as readonly string[]).includes(value ?? "") ? value as PaymentStatus : "ALL"
}

function readInitialSort(params: URLSearchParams): SortState<ConsolidatedInvoiceSortKey> {
  const key = params.get("sort")
  if (!key || !(CONSOLIDATED_INVOICE_SORT_KEYS as readonly string[]).includes(key)) return null
  return { key: key as ConsolidatedInvoiceSortKey, direction: params.get("dir") === "desc" ? "desc" : "asc" }
}

/**
 * Reports → Consolidated Invoice Report (plans/OF-INVOICE-consolidated-invoices.md, D6).
 * The filters live in the URL so a report can be bookmarked; every figure on
 * the page comes from the server, which also builds the PDF.
 */
export function ConsolidatedInvoiceReport() {
  const { data: session } = useSession()
  // An organization-wide Viewer reads its own organization's report, as Head
  // Office does: no organization picker.
  const { viewRole } = viewerAccessFor(session?.user)
  const role = viewRole ?? undefined
  const { organizationId: contextOrganizationId, isInitialized } = useAppContext()
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const { toast } = useToast()

  const today = karachiToday()
  const [mode, setMode] = useState<ConsolidatedInvoiceMode>(searchParams.get("mode") === "proformas" ? "proformas" : "invoices")
  const [periodKind, setPeriodKind] = useState<PeriodKind>(searchParams.get("period") === "range" ? "range" : "month")
  const [month, setMonth] = useState(searchParams.get("month") ?? today.slice(0, 7))
  const [from, setFrom] = useState(searchParams.get("from") ?? `${today.slice(0, 7)}-01`)
  const [to, setTo] = useState(searchParams.get("to") ?? today)
  const [branchIds, setBranchIds] = useState<string[]>(() => searchParams.get("branchIds")?.split(",").filter(Boolean) ?? [])
  const [groupIds, setGroupIds] = useState<string[]>(() => searchParams.get("groupId") ? [searchParams.get("groupId") as string] : [])
  const [includeCredited, setIncludeCredited] = useState(searchParams.get("includeCredited") === "true")
  const [paymentFilter, setPaymentFilter] = useState<PaymentFilter>(() => readInitialPaymentFilter(searchParams.get("paymentStatus")))
  const { sort, toggleSort } = useTableSort<ConsolidatedInvoiceSortKey>(readInitialSort(new URLSearchParams(searchParams.toString())))
  const [downloading, setDownloading] = useState(false)

  const organizationId = choosesOrganization(role) ? contextOrganizationId : null
  const needsOrganization = choosesOrganization(role) && !organizationId

  const query = useMemo(() => {
    const params = new URLSearchParams()
    if (organizationId) params.set("organizationId", String(organizationId))
    params.set("mode", mode)
    params.set("period", periodKind)
    if (periodKind === "month") {
      params.set("month", month)
    } else {
      params.set("from", from)
      params.set("to", to)
    }
    if (branchIds.length > 0) params.set("branchIds", branchIds.join(","))
    if (groupIds.length > 0) params.set("groupId", groupIds[0])
    if (mode === "invoices" && includeCredited) params.set("includeCredited", "true")
    if (mode === "invoices" && paymentFilter !== "ALL") params.set("paymentStatus", paymentFilter)
    if (sort) {
      params.set("sort", sort.key)
      params.set("dir", sort.direction)
    }
    return params.toString()
  }, [organizationId, mode, periodKind, month, from, to, branchIds, groupIds, includeCredited, paymentFilter, sort])

  // Keep the address bar in step, so the report can be bookmarked or shared.
  useEffect(() => {
    router.replace(`${pathname}?${query}`, { scroll: false })
  }, [router, pathname, query])

  const allowed = canReadConsolidatedInvoiceReport(role)
  const { data: report, error, isLoading } = useSWR<ConsolidatedInvoiceResponse, ReportRequestError>(
    allowed && isInitialized && !needsOrganization ? `/api/v1/reports/consolidated-invoice?${query}` : null,
    fetchReport,
    { keepPreviousData: true },
  )

  const download = useCallback(async () => {
    setDownloading(true)
    try {
      const response = await fetch(`/api/v1/reports/consolidated-invoice/pdf?${query}`)
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error || "The PDF could not be generated")
      }
      const blob = await response.blob()
      const disposition = response.headers.get("content-disposition") ?? ""
      const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `consolidated-${mode}.pdf`
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = safeFilenamePart(fileName, "consolidated-invoice.pdf")
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.URL.revokeObjectURL(url)
    } catch (downloadError) {
      toast({
        title: "Download failed",
        description: downloadError instanceof Error ? downloadError.message : "The PDF could not be generated",
        variant: "destructive",
      })
    } finally {
      setDownloading(false)
    }
  }, [query, mode, toast])

  if (session && !allowed) {
    return <p className="text-sm text-slate-500">This report is available to Super Admin and Head Office.</p>
  }

  const years = Array.from({ length: Number(today.slice(0, 4)) - FIRST_YEAR + 1 }, (_, index) => String(Number(today.slice(0, 4)) - index))
  const canDownload = Boolean(report && report.count > 0 && !isLoading && !downloading)

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Consolidated Invoice Report</h1>
        <p className="text-sm text-slate-500">
          Every tax invoice in a period, net of credit notes, in one document. Approved orders not yet delivered are listed separately as proformas.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
        <div className="space-y-1">
          <Label htmlFor="cir-mode">Documents</Label>
          <Select value={mode} onValueChange={(value) => setMode(value as ConsolidatedInvoiceMode)}>
            <SelectTrigger id="cir-mode" className="w-[230px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="invoices">Invoices (delivered)</SelectItem>
              <SelectItem value="proformas">Proformas (approved, not delivered)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="cir-period">Period</Label>
          <Select value={periodKind} onValueChange={(value) => setPeriodKind(value as PeriodKind)}>
            <SelectTrigger id="cir-period" className="w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="month">Month</SelectItem>
              <SelectItem value="range">Custom range</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {periodKind === "month" ? (
          <>
            <div className="space-y-1">
              <Label htmlFor="cir-month">Month</Label>
              <Select value={month.slice(5, 7)} onValueChange={(value) => setMonth(`${month.slice(0, 4)}-${value}`)}>
                <SelectTrigger id="cir-month" className="w-[150px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MONTH_NAMES.map((name, index) => (
                    <SelectItem key={name} value={String(index + 1).padStart(2, "0")}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cir-year">Year</Label>
              <Select value={month.slice(0, 4)} onValueChange={(value) => setMonth(`${value}-${month.slice(5, 7)}`)}>
                <SelectTrigger id="cir-year" className="w-[110px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {years.map((year) => <SelectItem key={year} value={year}>{year}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1">
              <Label htmlFor="cir-from">From</Label>
              <Input id="cir-from" type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} className="w-[160px]" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cir-to">To</Label>
              <Input id="cir-to" type="date" value={to} min={from} max={today} onChange={(event) => setTo(event.target.value)} className="w-[160px]" />
            </div>
          </>
        )}

        <div className="space-y-1">
          <span className="text-sm font-medium">Branches</span>
          <BranchFilter
            selectedIds={branchIds}
            onChange={setBranchIds}
            organizationId={organizationId ?? undefined}
            groupIds={groupIds}
            placeholder="All branches"
          />
        </div>
        <div className="space-y-1">
          <span className="text-sm font-medium">Group</span>
          <GroupFilter
            selectedIds={groupIds}
            onChange={(ids) => setGroupIds(ids.slice(-1))}
            organizationId={organizationId ?? undefined}
            placeholder="All groups"
          />
        </div>

        {mode === "invoices" && (
          <div className="space-y-1">
            <Label htmlFor="cir-payment">Payment</Label>
            <Select value={paymentFilter} onValueChange={(value) => setPaymentFilter(value as PaymentFilter)}>
              <SelectTrigger id="cir-payment" className="w-[130px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All</SelectItem>
                {PAYMENT_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>{PAYMENT_STATUS_LABELS[status]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {mode === "invoices" && (
          <div className="flex h-10 items-center gap-2">
            <Checkbox id="cir-credited" checked={includeCredited} onCheckedChange={(checked) => setIncludeCredited(checked === true)} />
            <Label htmlFor="cir-credited" className="font-normal">Include fully credited</Label>
          </div>
        )}

        <div className="ml-auto">
          <Button onClick={download} disabled={!canDownload} className="gap-2">
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {downloading ? "Generating…" : "Download PDF"}
          </Button>
        </div>
      </div>

      {needsOrganization && (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          Choose an organization in the context selector to build its report.
        </p>
      )}
      {!needsOrganization && isLoading && !report && (
        <div className="flex items-center justify-center gap-2 p-10 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Building the report…
        </div>
      )}
      {!needsOrganization && error && (
        <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error.message}
        </p>
      )}
      {!needsOrganization && !error && report && report.count === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-slate-300 p-10 text-sm text-slate-500">
          <FileText className="h-6 w-6" />
          No {mode === "invoices" ? "invoices" : "proformas"} match these filters.
        </div>
      )}
      {!needsOrganization && !error && report && report.count > 0 && (
        <ConsolidatedInvoiceDocument report={report} sort={sort} onSort={toggleSort} />
      )}
    </div>
  )
}
