"use client"

import { useDeferredValue, useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { format } from "date-fns"
import { Download, Loader2, RefreshCw, Search } from "lucide-react"
import * as XLSX from "xlsx"

import { healthStyle } from "@/components/warehouse/delivery-health-styles"
import { WarehouseOrderSheet } from "@/components/warehouse/warehouse-order-sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { toast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import type { FulfillmentStatus } from "@/lib/fulfillment-status"
import { formatPKR } from "@/lib/utils"
import {
  PICKING_LIST_HEADERS,
  WAREHOUSE_ORDER_PAGE_SIZE_MAX,
  buildPickingListRows,
  type PickingListOrder,
  type WarehouseOrderView,
} from "@/lib/warehouse-orders"

/**
 * The warehouse's queue: the approved orders of the branches assigned to it,
 * by stage, with an export of the picking / dispatch list. Every figure comes
 * from `GET /api/v1/warehouse/orders`, which fences to the user's branches.
 */

const ALL = "all"
const ENDPOINT = "/api/v1/warehouse/orders"
/** The export reads at most this many pages of the current filter. */
const EXPORT_MAX_PAGES = 10

type QueueRow = {
  id: number
  tid: string
  invoiceNumber: string | null
  organizationName: string
  branchName: string
  destination: string
  stage: FulfillmentStatus
  stageLabel: string
  healthLabel: string | null
  health: string | null
  paymentStatus: string
  totalCents: number
  notes: string | null
  approvedAt: string | null
  deliveredAt: string | null
  itemCount: number
  hasChallan: boolean
  lines?: Array<{ productCode: string | null; productName: string; unit: string; quantity: number; priceCents: number }>
}

type QueueResponse = {
  items: QueueRow[]
  total: number
  page: number
  limit: number
  counts: { NOT_STARTED: number; IN_PROCESS: number; OUT_FOR_DELIVERY: number; DELIVERED_RECENT: number }
  reach: {
    organizations: Array<{ id: number; name: string }>
    branches: Array<{ id: number; name: string; organizationId: number }>
  }
}

type Tab = { key: string; label: string; view: WarehouseOrderView; stage: FulfillmentStatus | null; count?: keyof QueueResponse["counts"] }

const TABS: Tab[] = [
  { key: "open", label: "All open", view: "open", stage: null },
  { key: "not-started", label: "Not started", view: "open", stage: "NOT_STARTED", count: "NOT_STARTED" },
  { key: "in-process", label: "In process", view: "open", stage: "IN_PROCESS", count: "IN_PROCESS" },
  { key: "out", label: "Out for delivery", view: "open", stage: "OUT_FOR_DELIVERY", count: "OUT_FOR_DELIVERY" },
  { key: "delivered", label: "Delivered (30 days)", view: "delivered", stage: null, count: "DELIVERED_RECENT" },
]


function when(value: string | null): string {
  if (!value) return "—"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "—" : format(date, "d MMM, h:mm a")
}

function buildQuery(input: { tab: Tab; organizationId: string; branchId: string; search: string; page: number; limit?: number; lines?: boolean }): string {
  const params = new URLSearchParams()
  params.set("view", input.tab.view)
  if (input.tab.stage) params.set("stage", input.tab.stage)
  if (input.organizationId !== ALL) params.set("organizationId", input.organizationId)
  if (input.branchId !== ALL) params.set("branchId", input.branchId)
  if (input.search) params.set("q", input.search)
  params.set("page", String(input.page))
  if (input.limit) params.set("limit", String(input.limit))
  if (input.lines) params.set("lines", "1")
  return `${ENDPOINT}?${params.toString()}`
}

export function WarehouseOrders() {
  const [tabKey, setTabKey] = useState("open")
  const [organizationId, setOrganizationId] = useState(ALL)
  const [branchId, setBranchId] = useState(ALL)
  const [searchInput, setSearchInput] = useState("")
  const search = useDeferredValue(searchInput.trim())
  const [page, setPage] = useState(1)
  const [openOrderId, setOpenOrderId] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)

  const tab = TABS.find((candidate) => candidate.key === tabKey) ?? TABS[0]
  const key = useMemo(
    () => buildQuery({ tab, organizationId, branchId, search, page }),
    [tab, organizationId, branchId, search, page],
  )
  const { data, error, isLoading, isValidating, mutate } = useSWR<QueueResponse>(key, fetcher, {
    keepPreviousData: true,
    refreshInterval: 60 * 1000,
  })

  const branchOptions = (data?.reach.branches ?? []).filter(
    (branch) => organizationId === ALL || String(branch.organizationId) === organizationId,
  )
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1

  // The queue refreshes every minute and orders leave it as they are
  // delivered, so the page being read can empty out from under the user. Step
  // back to the last page that exists rather than leaving them on an empty one
  // with the pager hidden.
  useEffect(() => {
    if (data && page > pageCount) setPage(pageCount)
  }, [data, page, pageCount])

  const exportList = async (kind: "xlsx" | "csv") => {
    if (exporting) return
    setExporting(true)
    try {
      const orders: PickingListOrder[] = []
      let total = 0
      for (let current = 1; current <= EXPORT_MAX_PAGES; current += 1) {
        const pageData = await fetcher<QueueResponse>(buildQuery({
          tab, organizationId, branchId, search, page: current, limit: WAREHOUSE_ORDER_PAGE_SIZE_MAX, lines: true,
        }))
        for (const row of pageData.items) {
          orders.push({
            tid: row.tid,
            invoiceNumber: row.invoiceNumber,
            organizationName: row.organizationName,
            branchName: row.branchName,
            destination: row.destination,
            fulfillmentStatus: row.stage,
            approvedAt: row.approvedAt,
            notes: row.notes,
            lines: row.lines ?? [],
          })
        }
        total = pageData.total
        if (current * pageData.limit >= pageData.total) break
      }
      const sheet = XLSX.utils.aoa_to_sheet([[...PICKING_LIST_HEADERS], ...buildPickingListRows(orders)])
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, "Picking list")
      XLSX.writeFile(book, `picking-list-${format(new Date(), "yyyy-MM-dd-HHmm")}.${kind}`)
      // A dispatch list that silently stops short loses orders on the floor.
      if (orders.length < total) {
        toast({
          title: `Exported ${orders.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} orders`,
          description: "One export carries at most this many. Narrow the filter by branch, stage or search, and export the rest separately.",
        })
      }
    } catch {
      toast({ title: "Export failed", description: "The picking list could not be built. Try again.", variant: "destructive" })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Order stage">
        {TABS.map((candidate) => (
          <Button
            key={candidate.key}
            role="tab"
            aria-selected={candidate.key === tab.key}
            size="sm"
            variant={candidate.key === tab.key ? "default" : "outline"}
            onClick={() => { setTabKey(candidate.key); setPage(1) }}
          >
            {candidate.label}
            {candidate.count && data && (
              <span className="ml-2 rounded-full bg-black/10 px-1.5 text-xs tabular-nums dark:bg-white/15">
                {data.counts[candidate.count]}
              </span>
            )}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="warehouse-org">Organization</Label>
          <Select value={organizationId} onValueChange={(value) => { setOrganizationId(value); setBranchId(ALL); setPage(1) }}>
            <SelectTrigger id="warehouse-org" className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All organizations</SelectItem>
              {(data?.reach.organizations ?? []).map((organization) => (
                <SelectItem key={organization.id} value={String(organization.id)}>{organization.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="warehouse-branch">Branch</Label>
          <Select value={branchId} onValueChange={(value) => { setBranchId(value); setPage(1) }}>
            <SelectTrigger id="warehouse-branch" className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All my branches</SelectItem>
              {branchOptions.map((branch) => (
                <SelectItem key={branch.id} value={String(branch.id)}>{branch.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="warehouse-search">Search</Label>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="warehouse-search"
              className="w-64 pl-8"
              placeholder="Order, invoice or branch"
              maxLength={100}
              value={searchInput}
              onChange={(event) => { setSearchInput(event.target.value); setPage(1) }}
            />
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { void mutate() }} disabled={isValidating}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isValidating ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => { void exportList("xlsx") }} disabled={exporting || !data?.total}>
            {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />} Excel
          </Button>
          <Button variant="outline" size="sm" onClick={() => { void exportList("csv") }} disabled={exporting || !data?.total}>
            <Download className="mr-2 h-4 w-4" /> CSV
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {error && <p role="alert" className="p-6 text-sm text-destructive">The orders could not be loaded.</p>}
          {isLoading && !data && (
            <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
          )}
          {data && data.reach.branches.length === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No branches are assigned to you yet. Ask Super Admin to assign your branches.
            </p>
          )}
          {data && data.reach.branches.length > 0 && data.items.length === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">No orders here.</p>
          )}
          {data && data.items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Order</th>
                    <th className="px-3 py-2">Branch</th>
                    <th className="px-3 py-2">Destination</th>
                    <th className="px-3 py-2">Stage</th>
                    <th className="px-3 py-2">Health</th>
                    <th className="px-3 py-2 text-right">Items</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2">Payment</th>
                    <th className="px-3 py-2">{tab.view === "delivered" ? "Delivered" : "Approved"}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <tr
                      key={row.id}
                      className="cursor-pointer border-t hover:bg-muted/40"
                      onClick={() => setOpenOrderId(row.id)}
                    >
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="font-medium text-primary underline-offset-4 hover:underline"
                          onClick={(event) => { event.stopPropagation(); setOpenOrderId(row.id) }}
                        >
                          {row.tid}
                        </button>
                        {row.invoiceNumber && <div className="text-xs text-muted-foreground">{row.invoiceNumber}</div>}
                      </td>
                      <td className="px-3 py-2">
                        <div>{row.branchName}</div>
                        <div className="text-xs text-muted-foreground">{row.organizationName}</div>
                      </td>
                      <td className="px-3 py-2">{row.destination}</td>
                      <td className="px-3 py-2">
                        <Badge variant="secondary">{row.stageLabel}</Badge>
                        {row.stage === "DELIVERED" && !row.hasChallan && (
                          <div className="mt-1 text-xs text-muted-foreground">No challan</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {row.healthLabel && (
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${healthStyle(row.health)}`}>
                            {row.healthLabel}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.itemCount}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatPKR(row.totalCents / 100)}</td>
                      <td className="px-3 py-2">{row.paymentStatus}</td>
                      <td className="px-3 py-2">{when(tab.view === "delivered" ? row.deliveredAt : row.approvedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {data && data.total > data.limit && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">Page {page} of {pageCount} · {data.total} orders</span>
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</Button>
          <Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>Next</Button>
        </div>
      )}

      <WarehouseOrderSheet orderId={openOrderId} onClose={() => setOpenOrderId(null)} onChanged={() => { void mutate() }} />
    </div>
  )
}
