"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Loader2 } from "lucide-react"

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
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import type { FulfillmentStatus } from "@/lib/fulfillment-status"
import { ORDER_CORRECTION_TEXT_MAX_LENGTH } from "@/lib/order-correction"
import { CANCELLATION_REASON_MAX_LENGTH, type IntakeChannel } from "@/lib/order-desk-access"
import {
  buildDeskEditRequest,
  buildDeskRefundRequest,
  estimateDraftTotalCents,
  NOTES_MAX_LENGTH,
  unavailableDraftLines,
  type DeskCatalogueItem,
} from "@/lib/order-desk-draft"
import { MAX_PO_NUMBER_LENGTH } from "@/lib/purchase-order"
import { formatQuantity } from "@/lib/quantity"
import { formatPKR } from "@/lib/utils"

/** One row of `GET /api/v1/order-desk/orders`. */
export type DeskOrder = {
  id: number
  tid: string
  status: string
  fulfillmentStatus: FulfillmentStatus
  /** Set while an Apricart Executive has it back with the desk for correction. */
  returnedForCorrectionAt: string | null
  correctionRequestNote: string | null
  rejectionReason: string | null
  canEdit: boolean
  canCancel: boolean
  canResubmit: boolean
  canFulfil: boolean
  canRequestRefund: boolean
  organizationId: number | null
  organizationName: string | null
  branchId: number
  branchName: string | null
  totalCents: number
  refundedCents: number
  pendingRefundCents: number
  poNumber: string | null
  notes: string | null
  intakeChannel: IntakeChannel | null
  intakeReference: string | null
  hasAttachment: boolean
  enteredBy: string | null
  createdAt: string | null
  deliveredAt: string | null
  fulfilledAt: string | null
  cancelledAt: string | null
  cancellationReason: string | null
  items: { id: number; organizationInventoryId: number | null; productName: string; quantity: number; unit: string | null; priceCents: number }[]
}

type DialogProps = Readonly<{ order: DeskOrder; onClose: () => void; onSaved: () => void }>

type CatalogueItem = DeskCatalogueItem & { productCode: string; unit: string; stockQuantity: number }

async function sendJson(url: string, method: string, body: unknown): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const data = await response.json().catch(() => ({}))
    const message = typeof data?.error === "string" ? data.error : (typeof data?.message === "string" ? data.message : "")
    return { ok: response.ok, message }
  } catch {
    return { ok: false, message: "The request could not be sent. Check the connection and try again." }
  }
}

/**
 * Change the lines, notes or PO number of an Active order that is not yet
 * delivered. Every product the branch may order is listed, prefilled with what
 * the order holds now; the server re-prices and re-checks stock and budget.
 */
export function EditDeskOrderDialog({ order, onClose, onSaved }: DialogProps) {
  const [quantities, setQuantities] = useState<Record<number, string>>(() => Object.fromEntries(
    order.items
      .filter((item) => item.organizationInventoryId !== null)
      .map((item) => [item.organizationInventoryId as number, String(item.quantity)]),
  ))
  const [notes, setNotes] = useState(order.notes ?? "")
  const [poNumber, setPoNumber] = useState(order.poNumber ?? "")
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const { data, error, isLoading } = useSWR<{ items: CatalogueItem[] }>(
    order.organizationId ? `/api/v1/order-desk/catalogue?organizationId=${order.organizationId}&branchId=${order.branchId}` : null,
    fetcher,
  )
  const catalogue = useMemo(() => data?.items ?? [], [data])
  const estimate = estimateDraftTotalCents({ quantities }, catalogue)
  // Lines of this order the branch no longer offers. Judged only once the
  // catalogue has loaded, or every line would look unavailable meanwhile.
  const unavailable = data
    ? unavailableDraftLines(quantities, catalogue).map((id) => ({
      id,
      name: order.items.find((item) => item.organizationInventoryId === id)?.productName ?? "A product",
    }))
    : []
  const removeLine = (inventoryId: number) => {
    setFormError(null)
    setQuantities((current) => ({ ...current, [inventoryId]: "" }))
  }

  const save = async () => {
    if (saving) return
    const built = buildDeskEditRequest({ quantities, notes, poNumber }, catalogue)
    if (!built.ok) {
      setFormError(built.error)
      return
    }
    setSaving(true)
    setFormError(null)
    const result = await sendJson(`/api/v1/order-desk/orders/${order.id}`, "PUT", built.body)
    setSaving(false)
    if (!result.ok) {
      setFormError(result.message || "The order could not be updated")
      return
    }
    toast({ title: order.tid, description: "Order updated" })
    onSaved()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Edit {order.tid}</DialogTitle>
          <DialogDescription>
            {order.organizationName} · {order.branchName}. The order is re-priced at today&apos;s prices when saved.
          </DialogDescription>
        </DialogHeader>

        {error && <p role="alert" className="text-sm text-destructive">Could not load this branch&apos;s products.</p>}
        {isLoading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading products…</p>
        )}
        {catalogue.length > 0 && (
          <div className="max-h-[320px] overflow-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/80 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="w-32 px-3 py-2">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {catalogue.map((item) => (
                  <tr key={item.organizationInventoryId} className="border-t">
                    <td className="px-3 py-2">
                      <div className="font-medium">{item.name}</div>
                      <div className="text-xs text-muted-foreground">{item.productCode} · per {item.unit}</div>
                    </td>
                    <td className="px-3 py-2 text-right">{item.priceCents === null ? "—" : formatPKR(item.priceCents / 100)}</td>
                    <td className="px-3 py-2">
                      <Input
                        aria-label={`Quantity for ${item.name}`}
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step={item.allowDecimalQuantity ? item.quantityStep : 1}
                        value={quantities[item.organizationInventoryId] ?? ""}
                        disabled={saving}
                        onChange={(event) => {
                          setFormError(null)
                          setQuantities((current) => ({ ...current, [item.organizationInventoryId]: event.target.value }))
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {unavailable.length > 0 && (
          <div role="alert" className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            <p>No longer available for this branch. Remove these lines to save the order:</p>
            <ul className="space-y-1">
              {unavailable.map((line) => (
                <li key={line.id} className="flex items-center justify-between gap-2">
                  <span className="font-medium">{line.name}</span>
                  <Button size="sm" variant="outline" disabled={saving} onClick={() => removeLine(line.id)}>
                    Remove {line.name}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="desk-edit-po">Customer PO number</Label>
            <Input id="desk-edit-po" maxLength={MAX_PO_NUMBER_LENGTH} value={poNumber} disabled={saving} onChange={(event) => setPoNumber(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="desk-edit-notes">Notes</Label>
            <Textarea id="desk-edit-notes" maxLength={NOTES_MAX_LENGTH} value={notes} disabled={saving} onChange={(event) => setNotes(event.target.value)} />
          </div>
        </div>

        <p className="text-sm">Estimated total: <span className="font-semibold">{formatPKR(estimate / 100)}</span></p>
        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Close</Button>
          <Button onClick={() => { void save() }} disabled={saving || catalogue.length === 0}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Withdraw an Active order before processing starts. The hold and stock are released. */
export function CancelDeskOrderDialog({ order, onClose, onSaved }: DialogProps) {
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const cancel = async () => {
    if (saving) return
    if (!reason.trim()) {
      setFormError("A reason is required")
      return
    }
    setSaving(true)
    setFormError(null)
    const result = await sendJson(`/api/v1/order-desk/orders/${order.id}/cancel`, "POST", { reason: reason.trim() })
    setSaving(false)
    if (!result.ok) {
      setFormError(result.message || "The order could not be cancelled")
      return
    }
    toast({ title: order.tid, description: "Order cancelled" })
    onSaved()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel {order.tid}?</DialogTitle>
          <DialogDescription>
            The order is withdrawn and its stock and budget are released. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="desk-cancel-reason">Reason</Label>
          <Textarea
            id="desk-cancel-reason"
            maxLength={CANCELLATION_REASON_MAX_LENGTH}
            value={reason}
            disabled={saving}
            onChange={(event) => { setFormError(null); setReason(event.target.value) }}
            placeholder="e.g. Customer withdrew the order by WhatsApp"
          />
        </div>
        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Keep order</Button>
          <Button variant="destructive" onClick={() => { void cancel() }} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Cancel order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Send an order an Apricart Executive returned for correction back for
 * approval. Edit it first if the correction is to the lines; the note is
 * optional.
 */
export function ResubmitDeskOrderDialog({ order, onClose, onSaved }: DialogProps) {
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const resubmit = async () => {
    if (saving) return
    setSaving(true)
    setFormError(null)
    const trimmed = note.trim()
    const result = await sendJson(`/api/v1/order-desk/orders/${order.id}/resubmit`, "POST", trimmed ? { note: trimmed } : {})
    setSaving(false)
    if (!result.ok) {
      setFormError(result.message || "The order could not be resubmitted")
      return
    }
    toast({ title: order.tid, description: "Sent back for approval" })
    onSaved()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resubmit {order.tid} for approval?</DialogTitle>
          <DialogDescription>
            The executive asked for a correction. Edit the order first if the lines need to change.
          </DialogDescription>
        </DialogHeader>
        {order.correctionRequestNote && (
          <p className="whitespace-pre-line rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            {order.correctionRequestNote}
          </p>
        )}
        <div className="space-y-1">
          <Label htmlFor="desk-resubmit-note">Note for the executive (optional)</Label>
          <Textarea
            id="desk-resubmit-note"
            maxLength={ORDER_CORRECTION_TEXT_MAX_LENGTH}
            value={note}
            disabled={saving}
            onChange={(event) => { setFormError(null); setNote(event.target.value) }}
            placeholder="e.g. Quantities corrected with the customer"
          />
        </div>
        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Not yet</Button>
          <Button onClick={() => { void resubmit() }} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Resubmit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Request a refund on a fulfilled order, for some or all of its lines. It is
 * held as pending until Super Admin approves it in Refunds.
 */
export function RefundDeskOrderDialog({ order, onClose, onSaved }: DialogProps) {
  const [quantities, setQuantities] = useState<Record<number, string>>({})
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const submit = async () => {
    if (saving) return
    const built = buildDeskRefundRequest(order.items, quantities, reason)
    if (!built.ok) {
      setFormError(built.error)
      return
    }
    setSaving(true)
    setFormError(null)
    const result = await sendJson(`/api/v1/orders/${order.id}/refunds`, "POST", built.body)
    setSaving(false)
    if (!result.ok) {
      setFormError(result.message || "The refund could not be requested")
      return
    }
    toast({ title: order.tid, description: "Refund requested — Super Admin will review it" })
    onSaved()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Request a refund for {order.tid}</DialogTitle>
          <DialogDescription>
            Enter how much of each item to refund. Super Admin approves the request before any money moves.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[300px] overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/80 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2 text-right">Ordered</th>
                <th className="w-32 px-3 py-2">Refund</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id} className="border-t">
                  <td className="px-3 py-2">{item.productName}</td>
                  <td className="px-3 py-2 text-right">{formatQuantity(item.quantity)} {item.unit ?? ""}</td>
                  <td className="px-3 py-2">
                    <Input
                      aria-label={`Refund quantity for ${item.productName}`}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={item.quantity}
                      value={quantities[item.id] ?? ""}
                      disabled={saving}
                      onChange={(event) => {
                        setFormError(null)
                        setQuantities((current) => ({ ...current, [item.id]: event.target.value }))
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-1">
          <Label htmlFor="desk-refund-reason">Reason</Label>
          <Textarea
            id="desk-refund-reason"
            maxLength={2000}
            value={reason}
            disabled={saving}
            onChange={(event) => { setFormError(null); setReason(event.target.value) }}
          />
        </div>
        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Close</Button>
          <Button onClick={() => { void submit() }} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Request refund
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
