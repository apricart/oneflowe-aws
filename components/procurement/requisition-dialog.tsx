"use client"

import { useState } from "react"
import { Loader2, Trash2 } from "lucide-react"

import { ProductPicker, sendJson, type PickerProduct } from "@/components/procurement/procurement-shared"
import { Button } from "@/components/ui/button"
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

/**
 * Ask Procurement to buy: a warehouse and the products it needs, no prices.
 * The warehouse's form and Procurement's alike; only the endpoint and the
 * warehouses offered differ. See plans/OF-PROCUREMENT-purchasing.md.
 */

type Line = { product: PickerProduct; quantity: string }

export function RequisitionDialog({
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
  const [note, setNote] = useState("")
  const [lines, setLines] = useState<Line[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const ready = warehouseId !== "" && lines.length > 0 && lines.every((line) => Number(line.quantity) > 0)

  const submit = async () => {
    setSubmitting(true)
    setFailure(null)
    try {
      const result = await sendJson<{ reference: string }>(endpoint, "POST", {
        warehouseId: Number(warehouseId),
        note: note.trim() || null,
        lines: lines.map((line) => ({ globalProductId: line.product.id, quantity: Number(line.quantity) })),
      })
      toast({ title: "Requisition raised", description: `${result.reference} is with Procurement.` })
      setLines([])
      setNote("")
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
          <DialogTitle>Raise a requisition</DialogTitle>
          <DialogDescription>What a warehouse needs bought. Procurement turns it into a purchase order.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="requisition-warehouse">Warehouse</Label>
          <Select value={warehouseId} onValueChange={setWarehouseId}>
            <SelectTrigger id="requisition-warehouse"><SelectValue placeholder="Choose a warehouse" /></SelectTrigger>
            <SelectContent>
              {warehouses.map((warehouse) => (
                <SelectItem key={warehouse.id} value={String(warehouse.id)}>{warehouse.code} — {warehouse.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ProductPicker
          endpoint={productEndpoint}
          excludeIds={lines.map((line) => line.product.id)}
          onPick={(product) => setLines((current) => [...current, { product, quantity: "" }])}
        />
        {lines.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="w-32">Quantity</TableHead>
                <TableHead className="w-10"><span className="sr-only">Remove</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => (
                <TableRow key={line.product.id}>
                  <TableCell>{line.product.name} <span className="text-xs text-muted-foreground">({line.product.unit})</span></TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min={0}
                      step={line.product.allowDecimalQuantity ? "0.001" : "1"}
                      value={line.quantity}
                      onChange={(event) => setLines((current) => current.map((item) => (item.product.id === line.product.id ? { ...item, quantity: event.target.value } : item)))}
                      aria-label={`Quantity of ${line.product.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <Button type="button" size="icon" variant="ghost" onClick={() => setLines((current) => current.filter((item) => item.product.id !== line.product.id))} aria-label={`Remove ${line.product.name}`}>
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="space-y-1">
          <Label htmlFor="requisition-note">Note (optional)</Label>
          <Textarea id="requisition-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} rows={2} />
        </div>
        {failure && <p className="text-sm text-red-600" role="alert">{failure}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={!ready || submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Raise requisition
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
