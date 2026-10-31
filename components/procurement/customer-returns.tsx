"use client"

import { useState } from "react"
import useSWR from "swr"
import { format } from "date-fns"
import { Loader2, Plus, Trash2 } from "lucide-react"

import {
  ListState,
  ProductPicker,
  ReasonDialog,
  StatusBadge,
  formatQty,
  sendJson,
  type PickerProduct,
} from "@/components/procurement/procurement-shared"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import type { ReturnCondition } from "@/lib/procurement"

/**
 * Customer returns: the list with its decisions (a warehouse executive or
 * Super Admin), and the form the warehouse records one with. Approving puts
 * resaleable goods back on the warehouse's shelf. See plans/OF-PROCUREMENT-purchasing.md.
 */

type ReturnRow = {
  id: number
  reference: string
  warehouse: { id: number; code: string; name: string }
  orderTid: string | null
  status: string
  reason: string
  recordedBy: string | null
  decidedBy: string | null
  decisionReason: string | null
  createdAt: string
  lines: Array<{ globalProductId: number; productName: string; unit: string; quantity: number; condition: string }>
}

export function CustomerReturnList({
  listEndpoint,
  decideEndpoint,
  emptyText = "No customer returns yet.",
}: Readonly<{ listEndpoint: string; decideEndpoint?: (id: number) => string; emptyText?: string }>) {
  const { data, error, isLoading, mutate } = useSWR<{ items: ReturnRow[]; hasWarehouses?: boolean }>(listEndpoint, fetcher)
  const [deciding, setDeciding] = useState<{ row: ReturnRow; action: "approve" | "reject" } | null>(null)
  const items = data?.items ?? []

  return (
    <div className="space-y-3">
      {data?.hasWarehouses === false && (
        <p className="text-sm text-muted-foreground">You are not an executive of any warehouse yet. Super Admin adds you on Warehouse Team.</p>
      )}
      <ListState isLoading={isLoading} error={error} empty={!isLoading && !error && items.length === 0} emptyText={emptyText} />
      {items.map((row) => (
        <Card key={row.id} className="space-y-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{row.reference}</span>
              <StatusBadge status={row.status} />
              <span className="text-xs text-muted-foreground">
                {row.warehouse.code} · {format(new Date(row.createdAt), "d MMM yyyy")}{row.orderTid ? ` · order ${row.orderTid}` : ""}
                {row.recordedBy ? ` · by ${row.recordedBy}` : ""}
              </span>
            </div>
            {decideEndpoint && row.status === "PENDING" && (
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setDeciding({ row, action: "reject" })}>Reject</Button>
                <Button type="button" size="sm" onClick={() => setDeciding({ row, action: "approve" })}>Approve</Button>
              </div>
            )}
          </div>
          <p className="text-sm">{row.reason}</p>
          <ul className="text-sm text-slate-600 dark:text-slate-300">
            {row.lines.map((line) => (
              <li key={`${line.globalProductId}-${line.condition}`}>
                {line.productName}: {formatQty(line.quantity)} {line.unit} — {line.condition === "RESALEABLE" ? "resaleable" : "damaged"}
              </li>
            ))}
          </ul>
          {row.decidedBy && (
            <p className="text-xs text-muted-foreground">Decided by {row.decidedBy}{row.decisionReason ? `: ${row.decisionReason}` : ""}</p>
          )}
        </Card>
      ))}
      {deciding && decideEndpoint && (
        <ReasonDialog
          open
          title={`${deciding.action === "approve" ? "Approve" : "Reject"} ${deciding.row.reference}`}
          description={deciding.action === "approve" ? "Resaleable goods go back on the warehouse's shelf." : "Nothing goes back on the shelf."}
          confirmLabel={deciding.action === "approve" ? "Approve" : "Reject"}
          optional={deciding.action === "approve"}
          onClose={() => setDeciding(null)}
          onConfirm={async (reason) => {
            await sendJson(decideEndpoint(deciding.row.id), "PATCH", { action: deciding.action, ...(reason ? { reason } : {}) })
            toast({ title: deciding.action === "approve" ? "Return approved" : "Return rejected" })
            await mutate()
          }}
        />
      )}
    </div>
  )
}

type ReturnLine = { product: PickerProduct; quantity: string; condition: ReturnCondition }

export function RecordReturnDialog({
  open,
  warehouses,
  productEndpoint,
  endpoint,
  onClose,
  onDone,
}: Readonly<{
  open: boolean
  warehouses: ReadonlyArray<{ id: number; code: string; name: string }>
  productEndpoint: string
  endpoint: string
  onClose: () => void
  onDone: () => void
}>) {
  const [warehouseId, setWarehouseId] = useState<string>(warehouses.length === 1 ? String(warehouses[0].id) : "")
  const [orderReference, setOrderReference] = useState("")
  const [reason, setReason] = useState("")
  const [lines, setLines] = useState<ReturnLine[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const ready = warehouseId !== "" && reason.trim().length >= 3 && lines.length > 0 && lines.every((line) => Number(line.quantity) > 0)

  const submit = async () => {
    setSubmitting(true)
    setFailure(null)
    try {
      const result = await sendJson<{ reference: string }>(endpoint, "POST", {
        warehouseId: Number(warehouseId),
        orderReference: orderReference.trim() || null,
        reason: reason.trim(),
        lines: lines.map((line) => ({ globalProductId: line.product.id, quantity: Number(line.quantity), condition: line.condition })),
      })
      toast({ title: "Return recorded", description: `${result.reference} is waiting for approval.` })
      setLines([])
      setReason("")
      setOrderReference("")
      onDone()
      onClose()
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record a customer return</DialogTitle>
          <DialogDescription>Goods a customer sent back. A warehouse executive or Super Admin approves it.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="return-warehouse">Warehouse</Label>
            <Select value={warehouseId} onValueChange={setWarehouseId}>
              <SelectTrigger id="return-warehouse"><SelectValue placeholder="Choose a warehouse" /></SelectTrigger>
              <SelectContent>
                {warehouses.map((warehouse) => (
                  <SelectItem key={warehouse.id} value={String(warehouse.id)}>{warehouse.code} — {warehouse.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="return-order">Order TID (optional)</Label>
            <Input id="return-order" value={orderReference} onChange={(event) => setOrderReference(event.target.value)} maxLength={64} />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="return-reason">Reason</Label>
          <Textarea id="return-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={2} />
        </div>
        <ProductPicker
          endpoint={productEndpoint}
          onPick={(product) => setLines((current) => [...current, { product, quantity: "", condition: "RESALEABLE" }])}
        />
        {lines.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="w-28">Quantity</TableHead>
                <TableHead className="w-40">Condition</TableHead>
                <TableHead className="w-10"><span className="sr-only">Remove</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line, index) => (
                <TableRow key={`${line.product.id}-${index}`}>
                  <TableCell>{line.product.name}</TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min={0}
                      step={line.product.allowDecimalQuantity ? "0.001" : "1"}
                      value={line.quantity}
                      onChange={(event) => setLines((current) => current.map((item, i) => (i === index ? { ...item, quantity: event.target.value } : item)))}
                      aria-label={`Quantity of ${line.product.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <Select
                      value={line.condition}
                      onValueChange={(value) => setLines((current) => current.map((item, i) => (i === index ? { ...item, condition: value as ReturnCondition } : item)))}
                    >
                      <SelectTrigger aria-label={`Condition of ${line.product.name}`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="RESALEABLE">Resaleable</SelectItem>
                        <SelectItem value="DAMAGED">Damaged</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Button type="button" size="icon" variant="ghost" onClick={() => setLines((current) => current.filter((_, i) => i !== index))} aria-label={`Remove ${line.product.name}`}>
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {failure && <p className="text-sm text-red-600" role="alert">{failure}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={!ready || submitting}>
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="mr-2 h-4 w-4" aria-hidden="true" />}
            Record return
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
