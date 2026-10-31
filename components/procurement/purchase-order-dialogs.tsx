"use client"

import { useState } from "react"
import useSWR from "swr"
import { format } from "date-fns"
import { Loader2, PackageCheck, Trash2 } from "lucide-react"

import {
  ReasonDialog,
  StatusBadge,
  formatQty,
  money,
  sendJson,
  ProductPicker,
  type PickerProduct,
} from "@/components/procurement/procurement-shared"
import { ReceiveGoodsDialog } from "@/components/procurement/receive-goods-dialog"
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
import { fetcher } from "@/lib/fetcher"
import { lineMoney, sumMoney, tolerancePercent } from "@/lib/procurement"
import {
  canApprovePurchaseOrders,
  canManageProcurement,
  canRecordGoodsReceiptAsAdmin,
  canRecordSupplierInvoices,
} from "@/lib/procurement-access"

/**
 * Purchase orders on the procurement page: drafting and editing one, reading
 * one with its costs, receipts and invoices, and acting on it as the role
 * allows. Totals shown here use the same rule as the server, which recomputes
 * them. See plans/OF-PROCUREMENT-purchasing.md.
 */

const ROOT = "/api/v1/procurement"

export type Supplier = { id: number; name: string; status: string }
export type Warehouse = { id: number; code: string; name: string; status: string }

type DraftLine = { product: Pick<PickerProduct, "id" | "name" | "unit" | "allowDecimalQuantity">; quantity: string; unitCost: string; taxPercent: string }

export type PurchaseOrderDraft = {
  id?: number
  updatedAt?: string
  requisitionId?: number | null
  supplierId?: number
  warehouseId?: number
  expectedDeliveryDate?: string | null
  notes?: string | null
  lines: DraftLine[]
}

const toCents = (value: string) => Math.round(Number(value) * 100)
const toBps = (value: string) => Math.round(Number(value || "0") * 100)

export function PurchaseOrderFormDialog({
  open,
  draft,
  suppliers,
  warehouses,
  onClose,
  onSaved,
}: Readonly<{
  open: boolean
  draft: PurchaseOrderDraft
  suppliers: readonly Supplier[]
  warehouses: readonly Warehouse[]
  onClose: () => void
  onSaved: (id: number) => void
}>) {
  const [supplierId, setSupplierId] = useState(draft.supplierId ? String(draft.supplierId) : "")
  const [warehouseId, setWarehouseId] = useState(draft.warehouseId ? String(draft.warehouseId) : "")
  const [expected, setExpected] = useState(draft.expectedDeliveryDate ?? "")
  const [notes, setNotes] = useState(draft.notes ?? "")
  const [lines, setLines] = useState<DraftLine[]>(draft.lines)
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const valid = (line: DraftLine) => Number(line.quantity) > 0 && line.unitCost.trim() !== "" && Number(line.unitCost) >= 0
  const ready = supplierId !== "" && warehouseId !== "" && lines.length > 0 && lines.every(valid)
  const totals = sumMoney(lines.filter(valid).map((line) => lineMoney({
    quantity: Number(line.quantity), unitCostCents: toCents(line.unitCost), taxRateBps: toBps(line.taxPercent),
  })))
  const update = (id: number, patch: Partial<DraftLine>) =>
    setLines((current) => current.map((line) => (line.product.id === id ? { ...line, ...patch } : line)))

  const submit = async () => {
    setSubmitting(true)
    setFailure(null)
    const body = {
      supplierId: Number(supplierId),
      warehouseId: Number(warehouseId),
      expectedDeliveryDate: expected || null,
      notes: notes.trim() || null,
      lines: lines.map((line) => ({
        globalProductId: line.product.id,
        quantity: Number(line.quantity),
        unitCostCents: toCents(line.unitCost),
        taxRateBps: toBps(line.taxPercent),
      })),
    }
    try {
      if (draft.id) {
        await sendJson(`${ROOT}/purchase-orders/${draft.id}`, "PATCH", { action: "update", expectedUpdatedAt: draft.updatedAt, ...body })
        toast({ title: "Purchase order saved" })
        onSaved(draft.id)
      } else {
        const result = await sendJson<{ id: number; reference: string }>(`${ROOT}/purchase-orders`, "POST", { ...body, requisitionId: draft.requisitionId ?? null })
        toast({ title: "Purchase order drafted", description: `${result.reference} is a draft. Submit it for approval when it is ready.` })
        onSaved(result.id)
      }
      onClose()
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{draft.id ? "Edit purchase order" : "New purchase order"}</DialogTitle>
          <DialogDescription>
            One supplier, one receiving warehouse. Unit costs are what Apricart pays, before tax.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="po-supplier">Supplier</Label>
            <Select value={supplierId} onValueChange={setSupplierId}>
              <SelectTrigger id="po-supplier"><SelectValue placeholder="Choose a supplier" /></SelectTrigger>
              <SelectContent>
                {suppliers.filter((supplier) => supplier.status === "ACTIVE").map((supplier) => (
                  <SelectItem key={supplier.id} value={String(supplier.id)}>{supplier.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="po-warehouse">Receiving warehouse</Label>
            <Select value={warehouseId} onValueChange={setWarehouseId} disabled={Boolean(draft.requisitionId)}>
              <SelectTrigger id="po-warehouse"><SelectValue placeholder="Choose a warehouse" /></SelectTrigger>
              <SelectContent>
                {warehouses.filter((warehouse) => warehouse.status === "ACTIVE").map((warehouse) => (
                  <SelectItem key={warehouse.id} value={String(warehouse.id)}>{warehouse.code} — {warehouse.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="po-expected">Expected delivery</Label>
            <Input id="po-expected" type="date" value={expected} onChange={(event) => setExpected(event.target.value)} />
          </div>
        </div>
        <ProductPicker
          endpoint={`${ROOT}/products`}
          excludeIds={lines.map((line) => line.product.id)}
          onPick={(product) => setLines((current) => [...current, { product, quantity: "", unitCost: "", taxPercent: "0" }])}
        />
        <div className="max-h-[40vh] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="w-28">Quantity</TableHead>
                <TableHead className="w-32">Unit cost (PKR)</TableHead>
                <TableHead className="w-24">Tax %</TableHead>
                <TableHead className="text-right">Line total</TableHead>
                <TableHead className="w-10"><span className="sr-only">Remove</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => (
                <TableRow key={line.product.id}>
                  <TableCell>{line.product.name} <span className="text-xs text-muted-foreground">({line.product.unit})</span></TableCell>
                  <TableCell>
                    <Input type="number" min={0} step={line.product.allowDecimalQuantity ? "0.001" : "1"} value={line.quantity}
                      onChange={(event) => update(line.product.id, { quantity: event.target.value })} aria-label={`Quantity of ${line.product.name}`} />
                  </TableCell>
                  <TableCell>
                    <Input type="number" min={0} step="0.01" value={line.unitCost}
                      onChange={(event) => update(line.product.id, { unitCost: event.target.value })} aria-label={`Unit cost of ${line.product.name}`} />
                  </TableCell>
                  <TableCell>
                    <Input type="number" min={0} max={100} step="0.01" value={line.taxPercent}
                      onChange={(event) => update(line.product.id, { taxPercent: event.target.value })} aria-label={`Tax rate of ${line.product.name}`} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {valid(line) ? money(lineMoney({ quantity: Number(line.quantity), unitCostCents: toCents(line.unitCost), taxRateBps: toBps(line.taxPercent) }).totalCents) : "—"}
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
        </div>
        <div className="flex flex-wrap justify-end gap-4 text-sm">
          <span>Subtotal <strong className="tabular-nums">{money(totals.subtotalCents)}</strong></span>
          <span>Tax <strong className="tabular-nums">{money(totals.taxCents)}</strong></span>
          <span>Total <strong className="tabular-nums">{money(totals.totalCents)}</strong></span>
        </div>
        <div className="space-y-1">
          <Label htmlFor="po-notes">Notes</Label>
          <Textarea id="po-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} rows={2} />
        </div>
        {failure && <p className="text-sm text-red-600" role="alert">{failure}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={!ready || submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {draft.id ? "Save" : "Save draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type PurchaseOrderDetail = {
  id: number
  reference: string
  status: string
  supplier: { id: number; name: string }
  warehouse: { id: number; code: string; name: string }
  requisition: { id: number; reference: string } | null
  expectedDeliveryDate: string | null
  notes: string | null
  overDeliveryToleranceBps: number
  toleranceIsSnapshot: boolean
  subtotalCents: number
  taxCents: number
  totalCents: number
  createdBy: string | null
  approvedBy: string | null
  approvedAt: string | null
  decidedBy: string | null
  decisionReason: string | null
  updatedAt: string
  lines: Array<{
    id: number
    globalProductId: number
    productName: string
    unit: string
    allowDecimalQuantity: boolean
    quantity: number
    unitCostCents: number
    taxRateBps: number
    lineTotalCents: number
    receivedQuantity: number
    outstandingQuantity: number
  }>
  receipts: Array<{ id: number; reference: string; receivedBy: string | null; receivedAt: string; supplierDeliveryNote: string | null; lines: Array<{ productName: string; quantity: number }> }>
  invoices: Array<{ id: number; invoiceNumber: string; invoiceDate: string; totalCents: number; matchStatus: string; status: string }>
}

type ReasonAction = "reject" | "cancel" | "close"

const REASON_COPY: Record<ReasonAction, { title: string; confirm: string }> = {
  reject: { title: "Reject purchase order", confirm: "Reject" },
  cancel: { title: "Cancel purchase order", confirm: "Cancel purchase order" },
  close: { title: "Close short", confirm: "Close short" },
}

export function PurchaseOrderDetailDialog({
  id,
  role,
  stockLedgerOn,
  suppliers,
  warehouses,
  onClose,
  onChanged,
}: Readonly<{
  id: number
  role: string | undefined
  stockLedgerOn: boolean
  suppliers: readonly Supplier[]
  warehouses: readonly Warehouse[]
  onClose: () => void
  onChanged: () => void
}>) {
  const { data, error, mutate } = useSWR<{ order: PurchaseOrderDetail }>(`${ROOT}/purchase-orders/${id}`, fetcher)
  const [busy, setBusy] = useState(false)
  const [reasonAction, setReasonAction] = useState<ReasonAction | null>(null)
  const [editing, setEditing] = useState(false)
  const [receiving, setReceiving] = useState(false)
  const [invoicing, setInvoicing] = useState(false)
  const order = data?.order
  const manage = canManageProcurement(role)

  const refresh = async () => { await mutate(); onChanged() }
  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!order) return
    await sendJson(`${ROOT}/purchase-orders/${order.id}`, "PATCH", { action, expectedUpdatedAt: order.updatedAt, ...extra })
    await refresh()
  }
  const quick = async (action: "submit" | "withdraw" | "approve", done: string) => {
    setBusy(true)
    try {
      await act(action)
      toast({ title: done })
    } catch (caught) {
      toast({ title: "Not done", description: caught instanceof Error ? caught.message : "Please try again.", variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  const receivable = order && (order.status === "APPROVED" || order.status === "PARTIALLY_RECEIVED")
  const nothingReceived = order?.lines.every((line) => line.receivedQuantity === 0) ?? false

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {order?.reference ?? "Purchase order"} {order && <StatusBadge status={order.status} />}
          </DialogTitle>
          {order && (
            <DialogDescription>
              {order.supplier.name} → {order.warehouse.code} ({order.warehouse.name})
              {order.requisition ? ` · from ${order.requisition.reference}` : ""}
              {order.expectedDeliveryDate ? ` · expected ${order.expectedDeliveryDate}` : ""}
            </DialogDescription>
          )}
        </DialogHeader>
        {error && <p className="text-sm text-red-600" role="alert">{error instanceof Error ? error.message : "Could not load the purchase order."}</p>}
        {order && (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Ordered</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Unit cost</TableHead>
                  <TableHead className="text-right">Tax</TableHead>
                  <TableHead className="text-right">Line total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell>{line.productName}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQty(line.quantity)} {line.unit}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQty(line.receivedQuantity)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(line.unitCostCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{line.taxRateBps / 100}%</TableCell>
                    <TableCell className="text-right tabular-nums">{money(line.lineTotalCents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex flex-wrap justify-end gap-4 text-sm">
              <span>Subtotal <strong className="tabular-nums">{money(order.subtotalCents)}</strong></span>
              <span>Tax <strong className="tabular-nums">{money(order.taxCents)}</strong></span>
              <span>Total <strong className="tabular-nums">{money(order.totalCents)}</strong></span>
            </div>
            <div className="grid gap-1 text-xs text-muted-foreground">
              <span>Over-delivery allowed: {tolerancePercent(order.overDeliveryToleranceBps)}%{order.toleranceIsSnapshot ? " (fixed at approval)" : " (today's setting; fixed when approved)"}</span>
              {order.createdBy && <span>Drafted by {order.createdBy}</span>}
              {order.approvedBy && order.approvedAt && <span>Approved by {order.approvedBy} on {format(new Date(order.approvedAt), "d MMM yyyy, HH:mm")}</span>}
              {order.decisionReason && <span>Reason: {order.decisionReason}{order.decidedBy ? ` (${order.decidedBy})` : ""}</span>}
              {order.notes && <span>Notes: {order.notes}</span>}
            </div>
            {order.receipts.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Goods receipts</p>
                {order.receipts.map((receipt) => (
                  <p key={receipt.id} className="text-xs text-slate-600 dark:text-slate-300">
                    {receipt.reference} · {format(new Date(receipt.receivedAt), "d MMM yyyy, HH:mm")}{receipt.receivedBy ? ` · ${receipt.receivedBy}` : ""}
                    {receipt.supplierDeliveryNote ? ` · DN ${receipt.supplierDeliveryNote}` : ""} —{" "}
                    {receipt.lines.map((line) => `${line.productName} ${formatQty(line.quantity)}`).join(", ")}
                  </p>
                ))}
              </div>
            )}
            {order.invoices.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Supplier invoices</p>
                {order.invoices.map((invoice) => (
                  <p key={invoice.id} className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                    {invoice.invoiceNumber} · {invoice.invoiceDate} · {money(invoice.totalCents)}
                    <StatusBadge status={invoice.matchStatus} /> <StatusBadge status={invoice.status} />
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
        {order && (
          <DialogFooter className="flex-wrap gap-2">
            {manage && order.status === "DRAFT" && (
              <>
                <Button type="button" variant="outline" onClick={() => setEditing(true)} disabled={busy}>Edit</Button>
                <Button type="button" onClick={() => quick("submit", "Submitted for approval")} disabled={busy}>Submit for approval</Button>
              </>
            )}
            {manage && order.status === "PENDING_APPROVAL" && (
              <Button type="button" variant="outline" onClick={() => quick("withdraw", "Withdrawn to draft")} disabled={busy}>Withdraw</Button>
            )}
            {canApprovePurchaseOrders(role) && order.status === "PENDING_APPROVAL" && (
              <>
                <Button type="button" variant="outline" onClick={() => setReasonAction("reject")} disabled={busy}>Reject</Button>
                <Button type="button" onClick={() => quick("approve", "Purchase order approved")} disabled={busy}>Approve</Button>
              </>
            )}
            {manage && (order.status === "DRAFT" || order.status === "PENDING_APPROVAL" || (order.status === "APPROVED" && nothingReceived)) && (
              <Button type="button" variant="outline" onClick={() => setReasonAction("cancel")} disabled={busy}>Cancel order</Button>
            )}
            {manage && order.status === "PARTIALLY_RECEIVED" && (
              <Button type="button" variant="outline" onClick={() => setReasonAction("close")} disabled={busy}>Close short</Button>
            )}
            {canRecordGoodsReceiptAsAdmin(role) && receivable && stockLedgerOn && (
              <Button type="button" variant="outline" onClick={() => setReceiving(true)} disabled={busy}>
                <PackageCheck className="mr-2 h-4 w-4" aria-hidden="true" /> Receive goods
              </Button>
            )}
            {canRecordSupplierInvoices(role) && ["APPROVED", "PARTIALLY_RECEIVED", "RECEIVED", "CLOSED"].includes(order.status) && (
              <Button type="button" variant="outline" onClick={() => setInvoicing(true)} disabled={busy}>Record supplier invoice</Button>
            )}
          </DialogFooter>
        )}
        {order && reasonAction && (
          <ReasonDialog
            open
            title={REASON_COPY[reasonAction].title}
            confirmLabel={REASON_COPY[reasonAction].confirm}
            onClose={() => setReasonAction(null)}
            onConfirm={async (reason) => {
              await act(reasonAction, { reason })
              toast({ title: "Done" })
            }}
          />
        )}
        {order && editing && (
          <PurchaseOrderFormDialog
            open
            draft={{
              id: order.id,
              updatedAt: order.updatedAt,
              requisitionId: order.requisition?.id ?? null,
              supplierId: order.supplier.id,
              warehouseId: order.warehouse.id,
              expectedDeliveryDate: order.expectedDeliveryDate,
              notes: order.notes,
              lines: order.lines.map((line) => ({
                product: { id: line.globalProductId, name: line.productName, unit: line.unit, allowDecimalQuantity: line.allowDecimalQuantity },
                quantity: String(line.quantity),
                unitCost: String(line.unitCostCents / 100),
                taxPercent: String(line.taxRateBps / 100),
              })),
            }}
            suppliers={suppliers}
            warehouses={warehouses}
            onClose={() => setEditing(false)}
            onSaved={() => { void refresh() }}
          />
        )}
        {order && receiving && (
          <ReceiveGoodsDialog
            open
            reference={order.reference}
            lines={order.lines}
            toleranceBps={order.overDeliveryToleranceBps}
            endpoint={`${ROOT}/purchase-orders/${order.id}/receipts`}
            onClose={() => setReceiving(false)}
            onDone={() => { void refresh() }}
          />
        )}
        {order && invoicing && (
          <SupplierInvoiceDialog order={order} onClose={() => setInvoicing(false)} onDone={() => { void refresh() }} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function SupplierInvoiceDialog({
  order,
  onClose,
  onDone,
}: Readonly<{ order: PurchaseOrderDetail; onClose: () => void; onDone: () => void }>) {
  const [invoiceNumber, setInvoiceNumber] = useState("")
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10))
  const [entries, setEntries] = useState<Record<number, { quantity: string; unitCost: string }>>(
    Object.fromEntries(order.lines.map((line) => [line.id, { quantity: "", unitCost: String(line.unitCostCents / 100) }])),
  )
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const lines = order.lines.flatMap((line) => {
    const entry = entries[line.id]
    return Number(entry?.quantity) > 0 ? [{ purchaseOrderLineId: line.id, quantity: Number(entry.quantity), unitCostCents: toCents(entry.unitCost) }] : []
  })
  const ready = invoiceNumber.trim() !== "" && invoiceDate !== "" && lines.length > 0

  const submit = async () => {
    setSubmitting(true)
    setFailure(null)
    try {
      const result = await sendJson<{ matchStatus: string; exceptions: string[] }>(`${ROOT}/supplier-invoices`, "POST", {
        purchaseOrderId: order.id, invoiceNumber: invoiceNumber.trim(), invoiceDate, lines,
      })
      toast({
        title: result.matchStatus === "MATCHED" ? "Invoice recorded — matches" : "Invoice recorded — does not match",
        description: result.matchStatus === "MATCHED" ? "Finance can approve it for payment." : result.exceptions.join(" "),
      })
      onDone()
      onClose()
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Record supplier invoice — {order.reference}</DialogTitle>
          <DialogDescription>Enter the invoice as the supplier wrote it. It is matched against the order and what was received.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="invoice-number">Supplier invoice no.</Label>
            <Input id="invoice-number" value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} maxLength={64} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="invoice-date">Invoice date</Label>
            <Input id="invoice-date" type="date" value={invoiceDate} onChange={(event) => setInvoiceDate(event.target.value)} />
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead className="text-right">PO unit cost</TableHead>
              <TableHead className="w-28">Invoiced qty</TableHead>
              <TableHead className="w-32">Invoiced unit cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {order.lines.map((line) => (
              <TableRow key={line.id}>
                <TableCell>{line.productName}</TableCell>
                <TableCell className="text-right tabular-nums">{formatQty(line.receivedQuantity)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(line.unitCostCents)}</TableCell>
                <TableCell>
                  <Input type="number" min={0} step={line.allowDecimalQuantity ? "0.001" : "1"} value={entries[line.id]?.quantity ?? ""}
                    onChange={(event) => setEntries((current) => ({ ...current, [line.id]: { ...current[line.id], quantity: event.target.value } }))}
                    aria-label={`Invoiced quantity of ${line.productName}`} />
                </TableCell>
                <TableCell>
                  <Input type="number" min={0} step="0.01" value={entries[line.id]?.unitCost ?? ""}
                    onChange={(event) => setEntries((current) => ({ ...current, [line.id]: { ...current[line.id], unitCost: event.target.value } }))}
                    aria-label={`Invoiced unit cost of ${line.productName}`} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {failure && <p className="text-sm text-red-600" role="alert">{failure}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={!ready || submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Record invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
