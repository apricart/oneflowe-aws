"use client"

import { useMemo, useState } from "react"
import Image from "next/image"
import useSWR from "swr"
import { Loader2, Package, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useDebounce } from "@/hooks/use-debounce"
import { fetcher } from "@/lib/fetcher"
import {
  WAREHOUSE_CATALOG_SEARCH_MAX_LENGTH,
  type WarehouseCatalogCategory,
  type WarehouseCatalogStatus,
} from "@/lib/warehouse-catalog"

/**
 * The global product catalogue, view only: what Super Admin sees under Global
 * Products, with no price and nothing to create, edit or delete. The endpoint
 * selects no price, so there is none in the payload
 * (plans/OF-WAREHOUSE-read-only-product-catalog.md).
 */

type CatalogItem = {
  id: number
  productCode: string
  name: string
  unit: string
  status: string
  stockQuantity: number
  low: boolean
  imageUrl: string | null
  category: string | null
  subcategory: string | null
}

type CatalogResponse = {
  items: CatalogItem[]
  total: number
  page: number
  limit: number
  lowStockThreshold: number
}

const ALL = "__all"
const STATUS_OPTIONS: ReadonlyArray<{ value: WarehouseCatalogStatus; label: string }> = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "all", label: "All statuses" },
]

export function WarehouseCatalog() {
  const [searchInput, setSearchInput] = useState("")
  const search = useDebounce(searchInput.trim(), 300)
  const [status, setStatus] = useState<WarehouseCatalogStatus>("active")
  const [categoryId, setCategoryId] = useState("")
  const [subcategoryId, setSubcategoryId] = useState("")
  const [page, setPage] = useState(1)

  const { data: categoryData } = useSWR<{ categories: WarehouseCatalogCategory[] }>(
    "/api/v1/warehouse/catalog/categories",
    fetcher,
    { revalidateOnFocus: false },
  )
  const categories = useMemo(() => categoryData?.categories ?? [], [categoryData])
  const subcategories = useMemo(
    () => categories.find((category) => String(category.id) === categoryId)?.subcategories ?? [],
    [categories, categoryId],
  )

  const params = new URLSearchParams({ page: String(page), status })
  if (search) params.set("q", search)
  if (categoryId) params.set("categoryId", categoryId)
  if (subcategoryId) params.set("subcategoryId", subcategoryId)
  const { data, error, isLoading } = useSWR<CatalogResponse>(`/api/v1/warehouse/catalog?${params.toString()}`, fetcher, {
    keepPreviousData: true,
  })
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1
  const filtered = Boolean(search || categoryId || subcategoryId || status !== "active")

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="catalog-search">Search</Label>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="catalog-search"
              className="w-64 pl-8"
              placeholder="Product name or code"
              maxLength={WAREHOUSE_CATALOG_SEARCH_MAX_LENGTH}
              value={searchInput}
              onChange={(event) => { setSearchInput(event.target.value); setPage(1) }}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="catalog-category">Category</Label>
          <Select
            value={categoryId || ALL}
            onValueChange={(value) => { setCategoryId(value === ALL ? "" : value); setSubcategoryId(""); setPage(1) }}
          >
            <SelectTrigger id="catalog-category" className="w-48 bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All categories</SelectItem>
              {categories.map((category) => (
                <SelectItem key={category.id} value={String(category.id)}>{category.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="catalog-subcategory">Subcategory</Label>
          <Select
            value={subcategoryId || ALL}
            onValueChange={(value) => { setSubcategoryId(value === ALL ? "" : value); setPage(1) }}
            disabled={!categoryId || subcategories.length === 0}
          >
            <SelectTrigger id="catalog-subcategory" className="w-48 bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All subcategories</SelectItem>
              {subcategories.map((subcategory) => (
                <SelectItem key={subcategory.id} value={String(subcategory.id)}>{subcategory.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="catalog-status">Status</Label>
          <Select
            value={status}
            onValueChange={(value) => { setStatus(value as WarehouseCatalogStatus); setPage(1) }}
          >
            <SelectTrigger id="catalog-status" className="w-40 bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {error && <p role="alert" className="p-6 text-sm text-destructive">The product catalogue could not be loaded.</p>}
          {isLoading && !data && (
            <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
          )}
          {data && data.items.length === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {filtered ? "No products match your filters." : "The catalogue has no products yet."}
            </p>
          )}
          {data && data.items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2">Subcategory</th>
                    <th className="px-3 py-2">Unit</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">In stock</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id} className="border-t">
                      <td className="max-w-[320px] px-3 py-2">
                        <div className="flex min-w-0 items-center gap-3">
                          {item.imageUrl ? (
                            <Image
                              src={item.imageUrl}
                              alt=""
                              width={40}
                              height={40}
                              unoptimized
                              className="h-10 w-10 shrink-0 rounded-md border object-cover"
                            />
                          ) : (
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-muted/40">
                              <Package className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                            </span>
                          )}
                          <div className="min-w-0">
                            <p className="truncate font-medium" title={item.name}>{item.name}</p>
                            <p className="truncate font-mono text-xs text-muted-foreground" title={item.productCode}>{item.productCode}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2">{item.category ?? <span className="text-muted-foreground">Uncategorized</span>}</td>
                      <td className="px-3 py-2">{item.subcategory ?? <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-3 py-2">{item.unit}</td>
                      <td className="px-3 py-2">
                        <Badge variant={item.status === "active" ? "default" : "secondary"}>{item.status}</Badge>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {item.stockQuantity}
                        {item.low && <Badge variant="destructive" className="ml-2">Low</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {data && data.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">
            Showing {(page - 1) * data.limit + 1}–{Math.min(data.total, page * data.limit)} of {data.total} products
          </span>
          {data.total > data.limit && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Page {page} of {pageCount}</span>
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</Button>
              <Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>Next</Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
