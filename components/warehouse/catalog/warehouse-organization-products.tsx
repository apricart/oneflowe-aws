"use client"

import { useState } from "react"
import useSWR from "swr"
import { Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ActiveBadge,
  CatalogHeader,
  LoadState,
  Pager,
  PickerSelect,
  ProductCell,
  day,
  money,
  useCatalogOrganizations,
} from "@/components/warehouse/catalog/catalog-parts"
import { useDebounce } from "@/hooks/use-debounce"
import { fetcher } from "@/lib/fetcher"
import { WAREHOUSE_CATALOG_SEARCH_MAX_LENGTH, type WarehouseCatalogStatus } from "@/lib/warehouse-catalog"

/**
 * Organization Products, view only: one organization's catalogue as Super
 * Admin's "View Assigned" lists it — product, code, price, status, assigned on —
 * for the organizations whose branches the warehouse serves. No assign,
 * activate or price control (plans/OF-WAREHOUSE-full-read-only-catalog.md).
 */

type OrganizationProduct = {
  id: number
  productCode: string
  name: string
  imageUrl: string | null
  unit: string
  category: string | null
  subcategory: string | null
  basePriceCents: number
  customPriceCents: number | null
  effectivePriceCents: number
  active: boolean
  assignedAt: string | null
}

type OrganizationProductsResponse = { items: OrganizationProduct[]; total: number; page: number; limit: number }

const STATUS_OPTIONS: ReadonlyArray<{ value: WarehouseCatalogStatus; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
]

export function WarehouseOrganizationProducts() {
  const { organizations, error: organizationsError } = useCatalogOrganizations()
  const [chosenOrganizationId, setOrganizationId] = useState("")
  const organizationId = chosenOrganizationId || (organizations[0] ? String(organizations[0].id) : "")
  const [searchInput, setSearchInput] = useState("")
  const search = useDebounce(searchInput.trim(), 300)
  const [status, setStatus] = useState<WarehouseCatalogStatus>("all")
  const [page, setPage] = useState(1)

  const params = new URLSearchParams({ organizationId, status, page: String(page) })
  if (search) params.set("q", search)
  const { data, error, isLoading } = useSWR<OrganizationProductsResponse>(
    organizationId ? `/api/v1/warehouse/catalog/organization-products?${params.toString()}` : null,
    fetcher,
    { keepPreviousData: true },
  )

  return (
    <div className="space-y-4">
      <CatalogHeader title="Organization Products" description="Each organization's catalogue and the price it pays." />
      {organizationsError && <p role="alert" className="text-sm text-destructive">Your organizations could not be loaded.</p>}
      {!organizationsError && organizations.length === 0 && (
        <p className="text-sm text-muted-foreground">No organization is in your reach yet. Super Admin assigns branches on Warehouse Team.</p>
      )}
      {organizations.length > 0 && (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <PickerSelect
              id="org-products-organization"
              label="Organization"
              value={organizationId}
              onChange={(value) => { setOrganizationId(value); setPage(1) }}
              options={organizations.map((organization) => ({ value: String(organization.id), label: organization.name }))}
            />
            <div className="space-y-1">
              <Label htmlFor="org-products-search">Search</Label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <Input
                  id="org-products-search"
                  className="w-64 pl-8"
                  placeholder="Product name or code"
                  maxLength={WAREHOUSE_CATALOG_SEARCH_MAX_LENGTH}
                  value={searchInput}
                  onChange={(event) => { setSearchInput(event.target.value); setPage(1) }}
                />
              </div>
            </div>
            <PickerSelect
              id="org-products-status"
              label="Status"
              value={status}
              onChange={(value) => { setStatus((value || "all") as WarehouseCatalogStatus); setPage(1) }}
              options={STATUS_OPTIONS}
            />
          </div>

          <Card>
            <CardContent className="p-0">
              <LoadState
                error={error}
                loading={isLoading && !data}
                empty={Boolean(data && data.items.length === 0)}
                emptyText={search || status !== "all" ? "No products match your filters." : "This organization has no products assigned."}
                errorText="The organization's products could not be loaded."
              >
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] text-sm">
                    <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2">Product</th>
                        <th className="px-3 py-2">Category</th>
                        <th className="px-3 py-2 text-right">Base price</th>
                        <th className="px-3 py-2 text-right">Custom price</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2">Assigned on</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data?.items ?? []).map((item) => (
                        <tr key={item.id} className="border-t">
                          <td className="max-w-[320px] px-3 py-2"><ProductCell name={item.name} code={item.productCode} imageUrl={item.imageUrl} /></td>
                          <td className="px-3 py-2">
                            {item.category ?? <span className="text-muted-foreground">Uncategorized</span>}
                            {item.subcategory && <span className="block text-xs text-muted-foreground">{item.subcategory}</span>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(item.basePriceCents)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {item.customPriceCents === null
                              ? <span className="text-muted-foreground" title="Inherits the base price">Base</span>
                              : <Badge variant="outline">{money(item.customPriceCents)}</Badge>}
                          </td>
                          <td className="px-3 py-2"><ActiveBadge active={item.active} /></td>
                          <td className="px-3 py-2 text-muted-foreground">{day(item.assignedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </LoadState>
            </CardContent>
          </Card>
          {data && <Pager page={page} limit={data.limit} total={data.total} noun="products" onPage={setPage} />}
        </>
      )}
    </div>
  )
}
