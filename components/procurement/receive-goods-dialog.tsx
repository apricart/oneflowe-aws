"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"

import { formatQty, sendJson } from "@/components/procurement/procurement-shared"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/hooks/use-toast"
import { fromMilli, maxReceivableMilli, toMilli, tolerancePercent } from "@/lib/procurement"

/**
 * Record what arrived against an approved purchase order — the warehouse's
 * receiving screen and Super Admin's alike; only the endpoint differs. Shows
 * how much more each line may take under the over-delivery allowance; the
 * server checks it again under the PO's lock. See plans/OF-PROCUREMENT-purchasing.md.
 */

export type ReceivableLine = {
  id: number
  productName: string
  unit: string
  quantity: number
  receivedQuantity: number
  allowDecimalQuantity: boolean
}

export function ReceiveGoodsDialog({
  open,
  reference,
  lines,
  toleranceBps,
  endpoint,
  onClose,
  onDone,
}: Readonly<{
  open: boolean
  reference: string
  lines: readonly ReceivableLine[]
  toleranceBps: number
  endpoint: string
  onClose: () => void
  onDone: () => void
}>) {
  const [quantities, setQuantities] = useState<Record<number, string>>({})
  const [deliveryNote, setDeliveryNote] = useState("")
  const [notes, setNotes] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const remaining = (line: ReceivableLine) =>
    fromMilli(Math.max(0, maxReceivableMilli(line.quantity, toleranceBps) - toMilli(line.receivedQuantity)))
  const entered = lines.flatMap((line) => {
    const value = Number(quantities[line.id])
    return quantities[line.id]?.trim() && Number.isFinite(value) && value > 0 ? [{ purchaseOrderLineId: line.id, quantity: value }] : []
  })

  const submit = async () => {
    setSubmitting(true)
    setFailure(null)
    try {
      const result = await sendJson<{ reference: string }>(endpoint, "POST", {
        lines: entered,
        supplierDeliveryNote: deliveryNote.trim() || null,
        notes: notes.trim() || null,
      })
      toast({ title: "Goods received", description: `${result.reference} recorded against ${reference}.` })
      setQuantities({})
      setDeliveryNote("")
      setNotes("")
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
          <DialogTitle>Receive goods — {reference}</DialogTitle>
          <DialogDescription>
            Enter what arrived. Up to {tolerancePercent(toleranceBps)}% more than ordered may be received on each line.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Ordered</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">May still take</TableHead>
                <TableHead className="w-32 text-right">Arrived now</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell>{line.productName}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(line.quantity)} {line.unit}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(line.receivedQuantity)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(remaining(line))}</TableCell>
                  <TableCell className="text-right">
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={line.allowDecimalQuantity ? "0.001" : "1"}
                      value={quantities[line.id] ?? ""}
                      onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value }))}
                      disabled={remaining(line) <= 0}
                      aria-label={`Quantity of ${line.productName} arrived`}
                      className="text-right"
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="receive-delivery-note">Supplier delivery note no.</Label>
            <Input id="receive-delivery-note" value={deliveryNote} onChange={(event) => setDeliveryNote(event.target.value)} maxLength={120} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="receive-notes">Notes</Label>
            <Textarea id="receive-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} rows={2} />
          </div>
        </div>
        {failure && <p className="text-sm text-red-600" role="alert">{failure}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={entered.length === 0 || submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Record receipt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
