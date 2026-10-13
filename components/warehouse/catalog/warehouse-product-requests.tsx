"use client"

import { Fragment, useState } from "react"
import Image from "next/image"
import useSWR from "swr"
import { ChevronDown, ChevronRight } from "lucide-react"

import { ProductRequestStatusBadge } from "@/components/product-requests/product-request-status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  CatalogHeader,
  LoadState,
  Pager,
  PickerSelect,
  day,
  money,
  useCatalogOrganizations,
} from "@/components/warehouse/catalog/catalog-parts"
import { fetcher } from "@/lib/fetcher"
import { isProductRequestStatus, PRODUCT_REQUEST_STATUS_LABELS, PRODUCT_REQUEST_STATUSES } from "@/lib/product-request"
import { cn } from "@/lib/utils"

/**
 * Product Requests, view only: what the organizations the warehouse serves have
 * asked Apricart to stock and where each request stands. The warehouse neither
 * raises nor decides one, so there is no form and no review control; no person
 * is named (plans/OF-WAREHOUSE-full-read-only-catalog.md).
 */

type ProductRequest = {
  id: number
  status: string
  productName: string | null
  brand: string | null
  description: string | null
  category: string | null
  subcategory: string | null
  unit: string | null
  packSize: string | null
  barcode: string | null
  expectedPriceCents: number | null
  estimatedMonthlyQuantity: number | null
  preferredSupplier: string | null
  referenceUrl: string | null
  notes: string | null
  imageUrl: string | null
  reviewNote: string | null
  estimatedAvailableOn: string | null
  organizationName: string
  createdAt: string | null
  reviewedAt: string | null
}

type ProductRequestsResponse = {
  items: ProductRequest[]
  total: number
  counts: Record<string, number>
  page: number
  limit: number
}

function Detail({ label, value }: Readonly<{ label: string; value: string | number | null }>) {
  if (value === null || value === "") return null
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      {/* Free text the requester typed: rendered as text, never as a link or HTML. */}
      <dd className="whitespace-pre-line break-words text-sm">{String(value)}</dd>
    </div>
  )
}

export function WarehouseProductRequests() {
  const { organizations } = useCatalogOrganizations()
  const [organizationId, setOrganizationId] = useState("")
  const [status, setStatus] = useState("")
  const [page, setPage] = useState(1)
  const [openId, setOpenId] = useState<number | null>(null)

  const params = new URLSearchParams({ page: String(page) })
  if (organizationId) params.set("organizationId", organizationId)
  if (status) params.set("status", status)
  const { data, error, isLoading } = useSWR<ProductRequestsResponse>(
    `/api/v1/warehouse/catalog/product-requests?${params.toString()}`,
    fetcher,
    { keepPreviousData: true },
  )
  const counts = data?.counts ?? {}
  const allCount = Object.values(counts).reduce((sum, value) => sum + value, 0)

  return (
    <div className="space-y-4">
      <CatalogHeader title="Product Requests" description="New products the organizations you serve have asked for." />
      <div className="flex flex-wrap items-end gap-4">
        <PickerSelect
          id="product-requests-organization"
          label="Organization"
          value={organizationId}
          allLabel="All organizations"
          onChange={(value) => { setOrganizationId(value); setPage(1) }}
          options={organizations.map((organization) => ({ value: String(organization.id), label: organization.name }))}
        />
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {["", ...PRODUCT_REQUEST_STATUSES].map((key) => {
          const active = status === key
          const label = key === "" ? "All" : PRODUCT_REQUEST_STATUS_LABELS[key as keyof typeof PRODUCT_REQUEST_STATUS_LABELS]
          return (
            <Button
              key={key || "all"}
              type="button"
              size="sm"
              variant={active ? "default" : "outline"}
              aria-pressed={active}
              onClick={() => { setStatus(key); setPage(1) }}
            >
              {label} <span className="ml-1 tabular-nums opacity-70">{key === "" ? allCount : counts[key] ?? 0}</span>
            </Button>
          )
        })}
      </div>

      <Card>
        <CardContent className="p-0">
          <LoadState
            error={error}
            loading={isLoading && !data}
            empty={Boolean(data && data.items.length === 0)}
            emptyText="No product requests match these filters."
            errorText="The product requests could not be loaded."
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="w-8 px-3 py-2"><span className="sr-only">Details</span></th>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2">Organization</th>
                    <th className="px-3 py-2 text-right">Expected price</th>
                    <th className="px-3 py-2">Requested on</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.items ?? []).map((item) => {
                    const open = openId === item.id
                    return (
                      <Fragment key={item.id}>
                        <tr className={cn("border-t", open && "bg-muted/30")}>
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-label={open ? "Hide details" : "Show details"}
                              onClick={() => setOpenId(open ? null : item.id)}
                              className="rounded p-1 hover:bg-muted"
                            >
                              {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </button>
                          </td>
                          <td className="px-3 py-2">
                            <p className="font-medium">{item.productName ?? "Untitled request"}</p>
                            {item.brand && <p className="text-xs text-muted-foreground">{item.brand}</p>}
                          </td>
                          <td className="px-3 py-2">
                            {item.category ?? <span className="text-muted-foreground">—</span>}
                            {item.subcategory && <span className="block text-xs text-muted-foreground">{item.subcategory}</span>}
                          </td>
                          <td className="px-3 py-2">{item.organizationName}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(item.expectedPriceCents)}</td>
                          <td className="px-3 py-2 text-muted-foreground">{day(item.createdAt)}</td>
                          <td className="px-3 py-2">
                            {isProductRequestStatus(item.status) ? <ProductRequestStatusBadge status={item.status} /> : item.status}
                          </td>
                        </tr>
                        {open && (
                          <tr className="bg-muted/30">
                            <td />
                            <td colSpan={6} className="px-3 pb-4">
                              <div className="flex flex-wrap gap-6">
                                {item.imageUrl && (
                                  <Image src={item.imageUrl} alt="" width={120} height={120} unoptimized className="h-28 w-28 rounded-md border object-cover" />
                                )}
                                <dl className="grid flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                  <Detail label="Description" value={item.description} />
                                  <Detail label="Unit" value={item.unit} />
                                  <Detail label="Pack size" value={item.packSize} />
                                  <Detail label="Barcode" value={item.barcode} />
                                  <Detail label="Estimated monthly quantity" value={item.estimatedMonthlyQuantity} />
                                  <Detail label="Preferred supplier" value={item.preferredSupplier} />
                                  <Detail label="Reference" value={item.referenceUrl} />
                                  <Detail label="Notes" value={item.notes} />
                                  <Detail label="Review note" value={item.reviewNote} />
                                  <Detail label="Decided on" value={item.reviewedAt ? day(item.reviewedAt) : null} />
                                  <Detail label="Expected in catalogue" value={item.estimatedAvailableOn ? day(item.estimatedAvailableOn) : null} />
                                </dl>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </LoadState>
        </CardContent>
      </Card>
      {data && <Pager page={page} limit={data.limit} total={data.total} noun="requests" onPage={setPage} />}
    </div>
  )
}
