"use client"

import { useState } from "react"
import useSWR from "swr"
import { Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CatalogHeader, LoadState, PickerSelect, day } from "@/components/warehouse/catalog/catalog-parts"
import { useDebounce } from "@/hooks/use-debounce"
import { fetcher } from "@/lib/fetcher"
import { WAREHOUSE_CATALOG_SEARCH_MAX_LENGTH } from "@/lib/warehouse-catalog"

/**
 * Categories or Subcategories, view only: Super Admin's lists with the same
 * columns — name, parent, counts, created — and none of its create, edit or
 * delete controls (plans/OF-WAREHOUSE-full-read-only-catalog.md).
 */

type TaxonomyRow = {
  id: number
  name: string
  parentId: number | null
  parentName: string | null
  subcategoriesCount: number
  productsCount: number
  createdAt: string | null
}

type TaxonomyResponse = { items: TaxonomyRow[]; total: number; truncated: boolean }

export function WarehouseTaxonomy({ level }: Readonly<{ level: "category" | "subcategory" }>) {
  const isCategory = level === "category"
  const [searchInput, setSearchInput] = useState("")
  const search = useDebounce(searchInput.trim(), 300)
  const [categoryId, setCategoryId] = useState("")

  const { data: parents } = useSWR<TaxonomyResponse>(
    isCategory ? null : "/api/v1/warehouse/catalog/taxonomy/categories",
    fetcher,
    { revalidateOnFocus: false },
  )

  const params = new URLSearchParams()
  if (search) params.set("q", search)
  if (!isCategory && categoryId) params.set("categoryId", categoryId)
  const base = `/api/v1/warehouse/catalog/taxonomy/${isCategory ? "categories" : "subcategories"}`
  const query = params.toString()
  const { data, error, isLoading } = useSWR<TaxonomyResponse>(query ? `${base}?${query}` : base, fetcher, { keepPreviousData: true })

  return (
    <div className="space-y-4">
      <CatalogHeader
        title={isCategory ? "Categories" : "Subcategories"}
        description={isCategory ? "Top-level product categories in Apricart's catalogue." : "Subcategories and the category each belongs to."}
      />
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor={`taxonomy-search-${level}`}>Search</Label>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id={`taxonomy-search-${level}`}
              className="w-64 pl-8"
              placeholder={isCategory ? "Category name" : "Subcategory name"}
              maxLength={WAREHOUSE_CATALOG_SEARCH_MAX_LENGTH}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </div>
        </div>
        {!isCategory && (
          <PickerSelect
            id="taxonomy-parent"
            label="Category"
            value={categoryId}
            onChange={setCategoryId}
            allLabel="All categories"
            options={(parents?.items ?? []).map((row) => ({ value: String(row.id), label: row.name }))}
          />
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <LoadState
            error={error}
            loading={isLoading && !data}
            empty={Boolean(data && data.items.length === 0)}
            emptyText={search || categoryId ? "Nothing matches your filters." : "Nothing here yet."}
            errorText={`The ${isCategory ? "categories" : "subcategories"} could not be loaded.`}
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">{isCategory ? "Subcategories" : "Category"}</th>
                    <th className="px-3 py-2 text-right">Products</th>
                    <th className="px-3 py-2">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.items ?? []).map((row) => (
                    <tr key={row.id} className="border-t">
                      <td className="px-3 py-2 font-medium">{row.name}</td>
                      <td className="px-3 py-2">
                        {isCategory
                          ? <Badge variant="secondary">{row.subcategoriesCount}</Badge>
                          : <Badge variant="outline">{row.parentName ?? "—"}</Badge>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.productsCount}</td>
                      <td className="px-3 py-2 text-muted-foreground">{day(row.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </LoadState>
        </CardContent>
      </Card>
      {data && (
        <p className="text-sm text-muted-foreground">
          {data.truncated ? `Showing the newest ${data.items.length} of ${data.total}. Search to narrow the list.` : `${data.total} in total`}
        </p>
      )}
    </div>
  )
}
