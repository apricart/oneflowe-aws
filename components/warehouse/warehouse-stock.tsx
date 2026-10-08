"use client"

import { useDeferredValue, useState } from "react"
import useSWR from "swr"
import { Loader2, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { fetcher } from "@/lib/fetcher"

/**
 * Available stock, read-only: every global product's stock quantity, the
 * figure each order decrements. The warehouse changes no stock here.
 */

type StockResponse = {
  items: Array<{ id: number; productCode: string; name: string; unit: string; status: string; stockQuantity: number; low: boolean }>
  total: number
  page: number
  limit: number
  lowStockThreshold: number
}

export function WarehouseStock() {
  const [searchInput, setSearchInput] = useState("")
  const search = useDeferredValue(searchInput.trim())
  const [lowOnly, setLowOnly] = useState(false)
  const [page, setPage] = useState(1)

  const params = new URLSearchParams({ page: String(page) })
  if (search) params.set("q", search)
  if (lowOnly) params.set("low", "1")
  const { data, error, isLoading } = useSWR<StockResponse>(`/api/v1/warehouse/stock?${params.toString()}`, fetcher, {
    keepPreviousData: true,
  })
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="stock-search">Search</Label>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="stock-search"
              className="w-64 pl-8"
              placeholder="Product name or code"
              maxLength={100}
              value={searchInput}
              onChange={(event) => { setSearchInput(event.target.value); setPage(1) }}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Checkbox id="stock-low" checked={lowOnly} onCheckedChange={(checked) => { setLowOnly(checked === true); setPage(1) }} />
          <Label htmlFor="stock-low">Running low only{data ? ` (≤ ${data.lowStockThreshold})` : ""}</Label>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {error && <p role="alert" className="p-6 text-sm text-destructive">Stock could not be loaded.</p>}
          {isLoading && !data && (
            <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
          )}
          {data && data.items.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No products match.</p>}
          {data && data.items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Code</th>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">Unit</th>
                    <th className="px-3 py-2 text-right">In stock</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id} className="border-t">
                      <td className="px-3 py-2 font-mono text-xs">{item.productCode}</td>
                      <td className="px-3 py-2">{item.name}</td>
                      <td className="px-3 py-2">{item.unit}</td>
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

      {data && data.total > data.limit && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">Page {page} of {pageCount}</span>
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</Button>
          <Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>Next</Button>
        </div>
      )}
    </div>
  )
}
