"use client"

import { useState } from "react"
import useSWR from "swr"
import { format } from "date-fns"
import { ArrowRightLeft, Loader2, Warehouse } from "lucide-react"

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
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import {
  ORDER_WAREHOUSE_TRANSFER_REASON_MAX_LENGTH,
  ORDER_WAREHOUSE_TRANSFER_REASON_MIN_LENGTH,
  ORDER_WAREHOUSE_TRANSFER_REFUSAL_MESSAGES,
  type OrderWarehouseTransferRefusal,
} from "@/lib/order-warehouse-transfer"

/**
 * Which Apricart warehouse fulfils this order, and moving it to another one.
 * Rendered for Super Admin only; the server refuses every other role, and
 * decides every rule (which orders may move, which warehouses may take one).
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
 */

type WarehouseSummary = { id: number; code: string; name: string; city: string | null }

export type OrderWarehousePanelData = {
  order: { id: number; tid: string; status: string; fulfillmentStatus: string | null; branchId: number; branchName: string }
  currentWarehouse: (WarehouseSummary & { status: string }) | null
  branchDefaultWarehouse: WarehouseSummary | null
  workedBy: Array<{ id: string; name: string }>
  branchServingAccountCount: number
  refusal: OrderWarehouseTransferRefusal | null
  targets: Array<WarehouseSummary & { operatorCount: number }>
  history: Array<{
    id: number
    from: WarehouseSummary | null
    to: WarehouseSummary | null
    reason: string
    transferredBy: string | null
    createdAt: string
  }>
}

/** The select's value for "hand back to the branch's own warehouse accounts". */
const BRANCH_REACH_VALUE = "branch"

function warehouseLabel(warehouse: WarehouseSummary | null): string {
  if (!warehouse) return "Branch's warehouse accounts"
  return warehouse.city ? `${warehouse.code} — ${warehouse.name} (${warehouse.city})` : `${warehouse.code} — ${warehouse.name}`
}

function TransferDialog({
  data,
  open,
  onOpenChange,
  onTransferred,
}: Readonly<{
  data: OrderWarehousePanelData
  open: boolean
  onOpenChange: (open: boolean) => void
  onTransferred: () => void
}>) {
  const [target, setTarget] = useState<string>("")
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const currentId = data.currentWarehouse?.id ?? null
  const choices = data.targets.filter((warehouse) => warehouse.id !== currentId)
  const canHandBack = currentId !== null
  const trimmedReason = reason.trim()
  const ready = target !== "" && trimmedReason.length >= ORDER_WAREHOUSE_TRANSFER_REASON_MIN_LENGTH && !submitting

  const close = (next: boolean) => {
    if (submitting) return
    if (!next) {
      setTarget("")
      setReason("")
    }
    onOpenChange(next)
  }

  const submit = async () => {
    if (!ready) return
    setSubmitting(true)
    try {
      const response = await fetch(`/api/v1/orders/${data.order.id}/fulfillment-warehouse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetWarehouseId: target === BRANCH_REACH_VALUE ? null : Number(target),
          expectedWarehouseId: currentId,
          reason: trimmedReason,
        }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || "The order could not be transferred")
      toast({ title: "Order transferred", description: `Order ${data.order.tid} has moved warehouse.` })
      setTarget("")
      setReason("")
      onOpenChange(false)
      onTransferred()
    } catch (caught) {
      toast({
        title: "Transfer failed",
        description: caught instanceof Error ? caught.message : "Please try again.",
        variant: "destructive",
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Transfer order {data.order.tid}</DialogTitle>
          <DialogDescription>
            The warehouse you choose picks, dispatches and delivers this order. Whoever works it now stops seeing it.
            Its branch, approval, budget and invoice do not change.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="order-warehouse-target">Move to</Label>
            <Select value={target} onValueChange={setTarget} disabled={submitting}>
              <SelectTrigger id="order-warehouse-target">
                <SelectValue placeholder="Choose a warehouse" />
              </SelectTrigger>
              <SelectContent>
                {choices.map((warehouse) => (
                  <SelectItem key={warehouse.id} value={String(warehouse.id)} disabled={warehouse.operatorCount === 0}>
                    {warehouseLabel(warehouse)}
                    {warehouse.operatorCount === 0 ? " — no active operator" : ` — ${warehouse.operatorCount} operator${warehouse.operatorCount === 1 ? "" : "s"}`}
                  </SelectItem>
                ))}
                {canHandBack && (
                  <SelectItem value={BRANCH_REACH_VALUE} disabled={data.branchServingAccountCount === 0}>
                    Back to the branch&apos;s warehouse accounts
                    {data.branchServingAccountCount === 0 ? " — none serve this branch" : ""}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            {choices.length === 0 && !canHandBack && (
              <p className="text-xs text-muted-foreground">
                No other active warehouse exists. Create one on Warehouse Team and add an operator to it.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="order-warehouse-reason">Reason</Label>
            <Textarea
              id="order-warehouse-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={ORDER_WAREHOUSE_TRANSFER_REASON_MAX_LENGTH}
              placeholder="For example: out of stock in Karachi, dispatching from Lahore"
              disabled={submitting}
              aria-describedby="order-warehouse-reason-hint"
            />
            <p id="order-warehouse-reason-hint" className="text-xs text-muted-foreground">
              Kept in the order&apos;s transfer history and the activity log.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)} disabled={submitting}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={!ready}>
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <ArrowRightLeft className="mr-2 h-4 w-4" aria-hidden="true" />}
            Transfer order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function OrderWarehousePanel({ orderId }: Readonly<{ orderId: number }>) {
  const { data, error, isLoading, mutate } = useSWR<OrderWarehousePanelData>(
    `/api/v1/orders/${orderId}/fulfillment-warehouse`,
    fetcher,
  )
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <Card className="space-y-3 rounded-2xl border-0 bg-white p-4 shadow-md dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
            <Warehouse className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Fulfilment warehouse
          </h3>
          <p className="text-xs text-muted-foreground">The Apricart warehouse that picks, dispatches and delivers this order.</p>
        </div>
        {data && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setDialogOpen(true)}
            disabled={data.refusal !== null}
            title={data.refusal ? ORDER_WAREHOUSE_TRANSFER_REFUSAL_MESSAGES[data.refusal] : undefined}
          >
            <ArrowRightLeft className="mr-2 h-4 w-4" aria-hidden="true" />
            Transfer to another warehouse
          </Button>
        )}
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && !isLoading && (
        <p className="text-sm text-red-600" role="alert">{error instanceof Error ? error.message : "Could not load the warehouse."}</p>
      )}
      {data && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-900 dark:text-white">
              {data.currentWarehouse ? warehouseLabel(data.currentWarehouse) : "Served by the branch's warehouse accounts"}
            </span>
            {data.currentWarehouse
              ? <Badge variant="secondary">Transferred</Badge>
              : <Badge variant="outline">Not transferred</Badge>}
            {data.currentWarehouse?.status === "INACTIVE" && <Badge variant="destructive">Inactive</Badge>}
          </div>
          {!data.currentWarehouse && data.branchDefaultWarehouse && (
            <p className="text-xs text-muted-foreground">Branch default warehouse: {warehouseLabel(data.branchDefaultWarehouse)}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {data.workedBy.length === 0
              ? "No active warehouse account works this order now."
              : `Worked now by: ${data.workedBy.map((account) => account.name).join(", ")}`}
          </p>
          {data.refusal && (
            <p className="text-xs text-amber-700 dark:text-amber-400">{ORDER_WAREHOUSE_TRANSFER_REFUSAL_MESSAGES[data.refusal]}</p>
          )}
          {data.history.length > 0 && (
            <div className="space-y-1 border-t border-slate-100 pt-3 dark:border-slate-800">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Transfer history</p>
              <ul className="space-y-2">
                {data.history.map((entry) => (
                  <li key={entry.id} className="text-xs text-slate-600 dark:text-slate-300">
                    <span className="font-medium">{warehouseLabel(entry.from)} → {warehouseLabel(entry.to)}</span>
                    <span className="text-muted-foreground"> · {format(new Date(entry.createdAt), "d MMM yyyy, HH:mm")}{entry.transferredBy ? ` · ${entry.transferredBy}` : ""}</span>
                    <p className="text-muted-foreground">{entry.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <TransferDialog data={data} open={dialogOpen} onOpenChange={setDialogOpen} onTransferred={() => mutate()} />
        </div>
      )}
    </Card>
  )
}
