"use client"

import { useState } from "react"
import useSWR from "swr"
import { format } from "date-fns"
import { History, Loader2, PencilLine, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import { formatQuantity } from "@/lib/quantity"
import {
  STOCK_ADJUSTMENT_REASON_MAX_LENGTH,
  planStockAdjustment,
  type StockAdjustmentMode,
} from "@/lib/warehouse-stock"

/**
 * Super Admin's Warehouse Stock page: each Apricart warehouse's figures, and
 * changing them with a reason. The server decides every rule and records each
 * change; this only shows and asks. See plans/OF-STOCK-per-warehouse-stock.md.
 */

type StockRow = {
  globalProductId: number
  productCode: string
  name: string
  unit: string
  status: string
  allowDecimalQuantity: boolean
  onHand: number
  reserved: number
  available: number
  updatedAt: string | null
}

export type WarehouseStockData = {
  mode: "global" | "warehouse"
  warehouses: Array<{ id: number; code: string; name: string; status: string }>
  warehouseId: number | null
  items: StockRow[]
  total: number
  page: number
  pageSize: number
  unassignedOpenOrders: number
}

type Movement = {
  id: number
  movementType: string
  quantityDelta: number
  balanceAfter: number
  orderId: number | null
  orderTid: string | null
  reason: string | null
  actorName: string | null
  createdAt: string
}

const PAGE_SIZE = 50

const MOVEMENT_LABELS: Record<string, string> = {
  OPENING: "Opening figure",
  ADJUSTMENT: "Adjusted",
  ORDER_ISSUE: "Order processed",
}

const MODE_LABELS: Record<StockAdjustmentMode, string> = {
  set: "Set to a counted figure",
  add: "Add stock",
  remove: "Remove stock",
}

function AdjustDialog({
  warehouseCode,
  warehouseId,
  row,
  onClose,
  onSaved,
}: Readonly<{
  warehouseCode: string
  warehouseId: number
  row: StockRow
  onClose: () => void
  onSaved: () => void
}>) {
  const [mode, setMode] = useState<StockAdjustmentMode>("set")
  const [quantity, setQuantity] = useState("")
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const parsed = quantity.trim() === "" ? Number.NaN : Number(quantity)
  const plan = Number.isFinite(parsed)
    ? planStockAdjustment({ mode, quantity: parsed, onHand: row.onHand, allowDecimalQuantity: row.allowDecimalQuantity })
    : null
  const ready = plan?.ok === true && reason.trim().length >= 3 && !submitting
  const belowReserved = plan?.ok === true && plan.onHandAfter < row.reserved

  const submit = async () => {
    if (!ready) return
    setSubmitting(true)
    try {
      const response = await fetch("/api/v1/admin/warehouse-stock/adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warehouseId, globalProductId: row.globalProductId, mode, quantity: parsed, reason: reason.trim() }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || "The stock could not be updated")
      toast({ title: "Stock updated", description: `${row.name} at ${warehouseCode}: ${formatQuantity(result.item?.onHandAfter ?? 0)} on hand.` })
      onSaved()
      onClose()
    } catch (caught) {
      toast({
        title: "Update failed",
        description: caught instanceof Error ? caught.message : "Please try again.",
        variant: "destructive",
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !submitting) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change stock — {row.name}</DialogTitle>
          <DialogDescription>
            {warehouseCode}: {formatQuantity(row.onHand)} on hand, {formatQuantity(row.reserved)} reserved by open orders.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <RadioGroup value={mode} onValueChange={(value) => setMode(value as StockAdjustmentMode)} aria-label="How to change the stock">
            {(Object.keys(MODE_LABELS) as StockAdjustmentMode[]).map((option) => (
              <div key={option} className="flex items-center gap-2">
                <RadioGroupItem id={`stock-mode-${option}`} value={option} disabled={submitting} />
                <Label htmlFor={`stock-mode-${option}`} className="font-normal">{MODE_LABELS[option]}</Label>
              </div>
            ))}
          </RadioGroup>
          <div className="space-y-2">
            <Label htmlFor="stock-quantity">{mode === "set" ? "Quantity on hand" : "Quantity"} ({row.unit})</Label>
            <Input
              id="stock-quantity"
              inputMode="decimal"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              disabled={submitting}
              aria-describedby="stock-quantity-hint"
            />
            <p id="stock-quantity-hint" className={`text-xs ${plan && !plan.ok ? "text-red-600" : "text-muted-foreground"}`} role={plan && !plan.ok ? "alert" : undefined}>
              {plan && !plan.ok
                ? plan.error
                : plan?.ok
                  ? `On hand becomes ${formatQuantity(plan.onHandAfter)}.`
                  : "Enter a quantity."}
            </p>
            {belowReserved && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                That is less than open orders have reserved here ({formatQuantity(row.reserved)}); some of them cannot be processed until stock arrives.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="stock-reason">Reason</Label>
            <Textarea
              id="stock-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={STOCK_ADJUSTMENT_REASON_MAX_LENGTH}
              placeholder="For example: monthly stock count"
              disabled={submitting}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={!ready}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function HistoryDialog({ warehouseId, row, onClose }: Readonly<{ warehouseId: number; row: StockRow; onClose: () => void }>) {
  const { data, error, isLoading } = useSWR<{ items: Movement[] }>(
    `/api/v1/admin/warehouse-stock/movements?warehouseId=${warehouseId}&globalProductId=${row.globalProductId}`,
    fetcher,
  )
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Stock history — {row.name}</DialogTitle>
          <DialogDescription>The latest changes to this warehouse&apos;s figure, newest first.</DialogDescription>
        </DialogHeader>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-red-600" role="alert">{error instanceof Error ? error.message : "Could not load the history."}</p>}
        {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">No changes recorded yet.</p>}
        {data && data.items.length > 0 && (
          <div className="max-h-96 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead className="text-right">Change</TableHead>
                  <TableHead className="text-right">On hand after</TableHead>
                  <TableHead>By / reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((movement) => (
                  <TableRow key={movement.id}>
                    <TableCell className="whitespace-nowrap text-xs">{format(new Date(movement.createdAt), "d MMM yyyy, HH:mm")}</TableCell>
                    <TableCell className="text-xs">
                      {MOVEMENT_LABELS[movement.movementType] ?? movement.movementType}
                      {movement.orderTid ? ` · ${movement.orderTid}` : ""}
                    </TableCell>
                    <TableCell className={`text-right text-xs ${movement.quantityDelta < 0 ? "text-red-600" : "text-emerald-700"}`}>
                      {movement.quantityDelta > 0 ? "+" : ""}{formatQuantity(movement.quantityDelta)}
                    </TableCell>
                    <TableCell className="text-right text-xs">{formatQuantity(movement.balanceAfter)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {[movement.actorName, movement.reason].filter(Boolean).join(" — ") || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function WarehouseStockManager() {
  const [warehouseId, setWarehouseId] = useState<number | null>(null)
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [adjusting, setAdjusting] = useState<StockRow | null>(null)
  const [viewing, setViewing] = useState<StockRow | null>(null)

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
  if (warehouseId !== null) params.set("warehouseId", String(warehouseId))
  if (search) params.set("search", search)
  const { data, error, isLoading, mutate } = useSWR<WarehouseStockData>(`/api/v1/admin/warehouse-stock?${params}`, fetcher)

  const selectedId = warehouseId ?? data?.warehouseId ?? null
  const selected = data?.warehouses.find((warehouse) => warehouse.id === selectedId) ?? null
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  return (
    <Card className="space-y-4 rounded-2xl border-0 bg-white p-4 shadow-md dark:border-slate-800 dark:bg-slate-900">
      {data?.mode === "global" && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          Orders still use the single global stock figure. These warehouse figures take effect when stock is switched to per-warehouse counting.
        </p>
      )}
      {data && data.unassignedOpenOrders > 0 && (
        <p className="text-xs text-muted-foreground">
          {data.unassignedOpenOrders} open order{data.unassignedOpenOrders === 1 ? " is" : "s are"} at branches with no warehouse; they reserve against every warehouse together until their branch is assigned one.
        </p>
      )}

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          setSearch(searchInput.trim())
          setPage(1)
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="warehouse-stock-warehouse">Warehouse</Label>
          <Select
            value={selectedId === null ? "" : String(selectedId)}
            onValueChange={(value) => { setWarehouseId(Number(value)); setPage(1) }}
          >
            <SelectTrigger id="warehouse-stock-warehouse" className="w-64">
              <SelectValue placeholder="Choose a warehouse" />
            </SelectTrigger>
            <SelectContent>
              {(data?.warehouses ?? []).map((warehouse) => (
                <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                  {warehouse.code} — {warehouse.name}{warehouse.status !== "ACTIVE" ? " (inactive)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="warehouse-stock-search">Product</Label>
          <Input
            id="warehouse-stock-search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Name or code"
            className="w-64"
          />
        </div>
        <Button type="submit" variant="outline">
          <Search className="mr-2 h-4 w-4" aria-hidden="true" />
          Search
        </Button>
      </form>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && !isLoading && (
        <p className="text-sm text-red-600" role="alert">{error instanceof Error ? error.message : "Could not load the stock."}</p>
      )}
      {data && !selected && <p className="text-sm text-muted-foreground">No warehouse exists yet. Create one on Warehouse Team.</p>}
      {data && selected && data.items.length === 0 && <p className="text-sm text-muted-foreground">No products match.</p>}

      {data && selected && data.items.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                  <TableHead className="text-right">Reserved</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((row) => (
                  <TableRow key={row.globalProductId}>
                    <TableCell>
                      <span className="font-medium">{row.name}</span>
                      <span className="ml-1 text-xs text-muted-foreground">({row.unit})</span>
                      {row.status !== "active" && <Badge variant="outline" className="ml-2">Inactive</Badge>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.productCode}</TableCell>
                    <TableCell className="text-right">{formatQuantity(row.onHand)}</TableCell>
                    <TableCell className="text-right">{formatQuantity(row.reserved)}</TableCell>
                    <TableCell className={`text-right font-medium ${row.available < 0 ? "text-red-600" : ""}`}>
                      {formatQuantity(row.available)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => setAdjusting(row)} aria-label={`Change stock of ${row.name}`}>
                          <PencilLine className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setViewing(row)} aria-label={`Stock history of ${row.name}`}>
                          <History className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{data.total} product{data.total === 1 ? "" : "s"}</span>
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <span>Page {page} of {totalPages}</span>
              <Button type="button" size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          </div>
        </>
      )}

      {adjusting && selected && (
        <AdjustDialog
          warehouseCode={selected.code}
          warehouseId={selected.id}
          row={adjusting}
          onClose={() => setAdjusting(null)}
          onSaved={() => mutate()}
        />
      )}
      {viewing && selected && <HistoryDialog warehouseId={selected.id} row={viewing} onClose={() => setViewing(null)} />}
    </Card>
  )
}
