"use client"

import { useState } from "react"
import useSWR from "swr"
import { AlertCircle, ChevronLeft, ChevronRight, PackagePlus, Plus, RefreshCw } from "lucide-react"

import { ProductRequestDetailDialog } from "@/components/product-requests/product-request-detail-dialog"
import { DIALOG_FITS_SCREEN } from "@/components/product-requests/dialog-layout"
import { ProductRequestForm } from "@/components/product-requests/product-request-form"
import { ProductRequestStatusBadge } from "@/components/product-requests/product-request-status-badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { fetcher } from "@/lib/fetcher"
import {
  PRODUCT_REQUEST_PAGE_SIZE_DEFAULT,
  PRODUCT_REQUEST_STATUSES,
  PRODUCT_REQUEST_STATUS_LABELS,
  isProductRequestImagePath,
  productRequestTitle,
  type ProductRequestList,
  type ProductRequestListItem,
  type ProductRequestStatus,
} from "@/lib/product-request"
import { canRaiseProductRequest, canReviewProductRequest } from "@/lib/product-request-access"
import { cn } from "@/lib/utils"

type StatusFilter = ProductRequestStatus | "all"
const ALL_ORGANIZATIONS = "all"

const dateLabel = (value: string) =>
  new Date(value).toLocaleDateString("en-PK", { day: "2-digit", month: "short", year: "numeric" })

function requestListUrl(status: StatusFilter, organizationId: string, page: number): string {
  const params = new URLSearchParams({ page: String(page), pageSize: String(PRODUCT_REQUEST_PAGE_SIZE_DEFAULT) })
  if (status !== "all") params.set("status", status)
  if (organizationId !== ALL_ORGANIZATIONS) params.set("organizationId", organizationId)
  return `/api/v1/product-requests?${params.toString()}`
}

/**
 * Product Catalog → Product Requests, for both roles that reach it.
 *
 * Head Office raises requests and follows its organization's; Super Admin
 * reads every tenant's and decides them. Which of those this viewer may do is
 * read from `lib/product-request-access.ts`; the handlers enforce the same rule.
 */
export default function ProductRequestsView({ role }: Readonly<{ role: string }>) {
  const canRaise = canRaiseProductRequest(role)
  const canReview = canReviewProductRequest(role)

  const [status, setStatus] = useState<StatusFilter>(canReview ? "PENDING" : "all")
  const [organizationId, setOrganizationId] = useState<string>(ALL_ORGANIZATIONS)
  const [page, setPage] = useState(1)
  const [formOpen, setFormOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const { data, error, isLoading, isValidating, mutate } = useSWR<ProductRequestList>(
    requestListUrl(status, organizationId, page),
    fetcher,
    { keepPreviousData: true, revalidateOnFocus: false },
  )

  const items = data?.items ?? []
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  const selected = items.find((item) => item.id === selectedId) ?? null

  const changeStatus = (value: string) => {
    setStatus(value as StatusFilter)
    setPage(1)
  }

  return (
    <div className="space-y-5 p-4 md:p-6">
      <ViewHeader
        canReview={canReview}
        canRaise={canRaise}
        refreshing={isValidating}
        onRefresh={() => void mutate()}
        onRequest={() => setFormOpen(true)}
      />

      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <StatusTabs status={status} counts={data?.counts ?? null} onChange={changeStatus} />
        {canReview ? (
          <OrganizationFilter
            value={organizationId}
            organizations={data?.organizations ?? []}
            onChange={(value) => {
              setOrganizationId(value)
              setPage(1)
            }}
          />
        ) : null}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <RequestListBody
          data={data}
          error={error}
          loading={isLoading}
          canRaise={canRaise}
          showOrganization={canReview}
          onOpen={setSelectedId}
        />
        {data && data.total > data.pageSize ? (
          <Pager page={page} pageCount={pageCount} total={data.total} onPage={setPage} />
        ) : null}
      </div>

      {canRaise ? (
        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent
            className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
            // Inline, not a utility class: the dialog fitting the screen is what keeps
            // its header and its actions reachable, so it must not depend on a class
            // having been generated. The body scrolls inside this height.
            style={DIALOG_FITS_SCREEN}
          >
            <DialogHeader className="border-b px-6 py-5 pr-12 text-left">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm">
                  <PackagePlus className="h-5 w-5" aria-hidden />
                </span>
                <div className="min-w-0 space-y-1">
                  <DialogTitle className="text-lg">Request a new product</DialogTitle>
                  <DialogDescription>Your request goes to Super Admin, who decides whether to add it to the catalogue.</DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <ProductRequestForm
              onCancel={() => setFormOpen(false)}
              onSubmitted={() => {
                setFormOpen(false)
                void mutate()
              }}
            />
          </DialogContent>
        </Dialog>
      ) : null}

      <ProductRequestDetailDialog
        request={selected}
        canReview={canReview}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null)
        }}
        onReviewed={() => {
          setSelectedId(null)
          void mutate()
        }}
      />
    </div>
  )
}

/** The loading, error, empty and populated states of the list — exactly one shows. */
function RequestListBody({
  data,
  error,
  loading,
  canRaise,
  showOrganization,
  onOpen,
}: Readonly<{
  data: ProductRequestList | undefined
  error: unknown
  loading: boolean
  canRaise: boolean
  showOrganization: boolean
  onOpen: (id: number) => void
}>) {
  if (!data && error) {
    return (
      <div role="alert" className="flex items-center gap-2 p-6 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />
        {error instanceof Error ? error.message : "Product requests could not be loaded"}
      </div>
    )
  }

  if (!data) {
    return loading ? (
      <div className="space-y-2 p-4">
        {Array.from({ length: 5 }, (_, index) => <Skeleton key={`row-${index + 1}`} className="h-12 w-full" />)}
      </div>
    ) : null
  }

  if (data.items.length === 0) {
    return (
      <Empty className="py-12">
        <EmptyHeader>
          <EmptyMedia variant="icon"><PackagePlus /></EmptyMedia>
          <EmptyTitle>No product requests</EmptyTitle>
          <EmptyDescription>
            {canRaise
              ? "Nothing requested yet. Use “Request a product” to ask Super Admin for one."
              : "Nothing matches these filters."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return <ProductRequestsTable items={data.items} showOrganization={showOrganization} onOpen={onOpen} />
}

function ProductRequestsTable({
  items,
  showOrganization,
  onOpen,
}: Readonly<{ items: ProductRequestListItem[]; showOrganization: boolean; onOpen: (id: number) => void }>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Product</TableHead>
          <TableHead>Category</TableHead>
          <TableHead>Requested by</TableHead>
          {showOrganization ? <TableHead>Organization</TableHead> : null}
          <TableHead>Requested on</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow
            key={item.id}
            tabIndex={0}
            className="cursor-pointer"
            onClick={() => onOpen(item.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                onOpen(item.id)
              }
            }}
            aria-label={`Open request for ${productRequestTitle(item)}`}
          >
            <TableCell>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/30">
                  {isProductRequestImagePath(item.imageUrl) ? (
                    // eslint-disable-next-line @next/next/no-img-element -- an authenticated application path, not a static asset
                    <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <PackagePlus className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="truncate font-medium">{productRequestTitle(item)}</p>
                  {item.brand && item.productName ? (
                    <p className="truncate text-xs text-muted-foreground">{item.brand}</p>
                  ) : null}
                </div>
              </div>
            </TableCell>
            <TableCell className="text-sm">
              {[item.category?.name, item.subcategory?.name].filter(Boolean).join(" › ") || "—"}
            </TableCell>
            <TableCell>
              <p className="text-sm">{item.requestedBy.fullName || "—"}</p>
              <p className="text-xs text-muted-foreground">{item.requestedBy.email}</p>
            </TableCell>
            {showOrganization ? <TableCell className="text-sm">{item.organization.name}</TableCell> : null}
            <TableCell className="text-sm">{dateLabel(item.createdAt)}</TableCell>
            <TableCell><ProductRequestStatusBadge status={item.status} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function ViewHeader({
  canReview,
  canRaise,
  refreshing,
  onRefresh,
  onRequest,
}: Readonly<{
  canReview: boolean
  canRaise: boolean
  refreshing: boolean
  onRefresh: () => void
  onRequest: () => void
}>) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)] dark:border-slate-800 dark:bg-slate-900 md:flex-row md:items-center md:justify-between md:p-5">
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-blue-100 bg-gradient-to-tr from-blue-100 to-indigo-100 text-blue-600 shadow-inner dark:border-blue-800 dark:from-blue-950 dark:to-indigo-950 dark:text-blue-300">
          <PackagePlus className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Product Requests</h1>
          <p className="mt-1 text-xs font-medium text-slate-500 dark:text-slate-400">
            {canReview
              ? "Products Head Office has asked the catalogue to carry, and who asked for them."
              : "Ask Super Admin to add a product the catalogue does not carry yet."}
          </p>
        </div>
      </div>
      <div className="flex gap-2 self-start md:self-auto">
        <Button variant="outline" size="sm" className="gap-2" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
          Refresh
        </Button>
        {canRaise ? (
          <Button size="sm" className="gap-2" onClick={onRequest}>
            <Plus className="h-4 w-4" />
            Request a product
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function StatusTabs({
  status,
  counts,
  onChange,
}: Readonly<{
  status: StatusFilter
  counts: Record<ProductRequestStatus, number> | null
  onChange: (value: string) => void
}>) {
  const suffix = (count: number | undefined) => (count === undefined ? "" : ` (${count})`)
  const total = counts ? PRODUCT_REQUEST_STATUSES.reduce((sum, key) => sum + counts[key], 0) : undefined
  return (
    <Tabs value={status} onValueChange={onChange}>
      <TabsList>
        <TabsTrigger value="all">All{suffix(total)}</TabsTrigger>
        {PRODUCT_REQUEST_STATUSES.map((key) => (
          <TabsTrigger key={key} value={key}>
            {PRODUCT_REQUEST_STATUS_LABELS[key]}{suffix(counts?.[key])}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}

function OrganizationFilter({
  value,
  organizations,
  onChange,
}: Readonly<{
  value: string
  organizations: Array<{ id: number; name: string }>
  onChange: (value: string) => void
}>) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full md:w-64" aria-label="Filter by organization">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_ORGANIZATIONS}>All organizations</SelectItem>
        {organizations.map((organization) => (
          <SelectItem key={organization.id} value={String(organization.id)}>{organization.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function Pager({
  page,
  pageCount,
  total,
  onPage,
}: Readonly<{ page: number; pageCount: number; total: number; onPage: (page: number) => void }>) {
  return (
    <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
      <span className="text-muted-foreground">Page {page} of {pageCount} · {total} requests</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => onPage(page - 1)} disabled={page <= 1}>
          <ChevronLeft className="h-4 w-4" /> Previous
        </Button>
        <Button variant="outline" size="sm" onClick={() => onPage(page + 1)} disabled={page >= pageCount}>
          Next <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
