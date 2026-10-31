"use client"

import { useState } from "react"
import useSWR from "swr"
import { format } from "date-fns"
import { PackageCheck, Plus } from "lucide-react"

import { CustomerReturnList, RecordReturnDialog } from "@/components/procurement/customer-returns"
import { ListState, ReasonDialog, StatusBadge, formatQty, sendJson } from "@/components/procurement/procurement-shared"
import { ReceiveGoodsDialog, type ReceivableLine } from "@/components/procurement/receive-goods-dialog"
import { RequisitionDialog } from "@/components/procurement/requisition-dialog"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"

/**
 * The warehouse's purchasing sections: its requisitions, receiving against
 * approved purchase orders, and customer returns — for the warehouses it works
 * only, and never a cost. Every call is on `/api/v1/warehouse/procurement/*`.
 * See plans/OF-PROCUREMENT-purchasing.md.
 */

const ROOT = "/api/v1/warehouse/procurement"
const PRODUCTS = `${ROOT}/products`

type Warehouse = { id: number; code: string; name: string; status: string }

function useMyWarehouses() {
  return useSWR<{ items: Warehouse[]; stockLedgerOn: boolean }>(`${ROOT}/warehouses`, fetcher)
}

function NoWarehouse() {
  return (
    <Card className="p-4 text-sm text-muted-foreground">
      You are not an operator of any Apricart warehouse yet. Super Admin adds you to one on Warehouse Team.
    </Card>
  )
}

type Requisition = {
  id: number
  reference: string
  warehouse: { code: string }
  status: string
  note: string | null
  decisionReason: string | null
  purchaseOrderReference: string | null
  createdAt: string
  lines: Array<{ globalProductId: number; productName: string; unit: string; quantity: number }>
}

export function WarehouseRequisitions() {
  const warehouses = useMyWarehouses()
  const { data, error, isLoading, mutate } = useSWR<{ items: Requisition[] }>(`${ROOT}/requisitions`, fetcher)
  const [raising, setRaising] = useState(false)
  const [cancelling, setCancelling] = useState<Requisition | null>(null)
  const mine = warehouses.data?.items ?? []
  const items = data?.items ?? []

  if (warehouses.data && mine.length === 0) return <NoWarehouse />
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Requisitions</h2>
          <p className="text-sm text-muted-foreground">Ask Procurement to buy for your warehouse.</p>
        </div>
        <Button type="button" onClick={() => setRaising(true)} disabled={mine.length === 0}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> Raise requisition
        </Button>
      </div>
      <ListState isLoading={isLoading} error={error} empty={!isLoading && !error && items.length === 0} emptyText="No requisitions yet." />
      {items.map((row) => (
        <Card key={row.id} className="space-y-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{row.reference}</span>
              <StatusBadge status={row.status} />
              <span className="text-xs text-muted-foreground">{row.warehouse.code} · {format(new Date(row.createdAt), "d MMM yyyy")}</span>
              {row.purchaseOrderReference && <span className="text-xs text-muted-foreground">→ {row.purchaseOrderReference}</span>}
            </div>
            {row.status === "SUBMITTED" && (
              <Button type="button" size="sm" variant="outline" onClick={() => setCancelling(row)}>Cancel</Button>
            )}
          </div>
          <ul className="text-sm text-slate-600 dark:text-slate-300">
            {row.lines.map((line) => <li key={line.globalProductId}>{line.productName}: {formatQty(line.quantity)} {line.unit}</li>)}
          </ul>
          {row.note && <p className="text-xs text-muted-foreground">{row.note}</p>}
          {row.decisionReason && <p className="text-xs text-muted-foreground">Reason: {row.decisionReason}</p>}
        </Card>
      ))}
      {raising && (
        <RequisitionDialog
          open
          warehouses={mine}
          productEndpoint={PRODUCTS}
          endpoint={`${ROOT}/requisitions`}
          onClose={() => setRaising(false)}
          onDone={() => { void mutate() }}
        />
      )}
      {cancelling && (
        <ReasonDialog
          open
          title={`Cancel ${cancelling.reference}`}
          confirmLabel="Cancel requisition"
          onClose={() => setCancelling(null)}
          onConfirm={async (reason) => {
            await sendJson(`${ROOT}/requisitions/${cancelling.id}`, "PATCH", { action: "cancel", reason })
            toast({ title: "Requisition cancelled" })
            await mutate()
          }}
        />
      )}
    </div>
  )
}

type ReceivingRow = {
  id: number
  reference: string
  status: string
  supplierName: string
  warehouse: { code: string }
  expectedDeliveryDate: string | null
  orderedQuantity: number
  receivedQuantity: number
}

type ReceivingDetail = {
  id: number
  reference: string
  overDeliveryToleranceBps: number
  lines: ReceivableLine[]
  receipts: Array<{ id: number; reference: string; receivedBy: string | null; receivedAt: string; lines: Array<{ productName: string; quantity: number }> }>
}

export function WarehouseReceiving() {
  const warehouses = useMyWarehouses()
  const { data, error, isLoading, mutate } = useSWR<{ items: ReceivingRow[]; stockLedgerOn: boolean }>(`${ROOT}/purchase-orders`, fetcher)
  const [openId, setOpenId] = useState<number | null>(null)
  const detail = useSWR<{ order: ReceivingDetail }>(openId ? `${ROOT}/purchase-orders/${openId}` : null, fetcher)
  const [receiving, setReceiving] = useState(false)
  const items = data?.items ?? []

  if (warehouses.data && warehouses.data.items.length === 0) return <NoWarehouse />
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Receiving</h2>
        <p className="text-sm text-muted-foreground">Approved purchase orders coming into your warehouse. Record what arrives.</p>
      </div>
      {data && !data.stockLedgerOn && (
        <Card className="border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Receiving opens once stock is counted per warehouse. Until then you can see what is on order.
        </Card>
      )}
      <ListState isLoading={isLoading} error={error} empty={!isLoading && !error && items.length === 0} emptyText="No approved purchase orders for your warehouse." />
      {items.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Purchase order</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>Expected</TableHead>
                <TableHead className="text-right">Received / ordered</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((row) => (
                <TableRow key={row.id} className="cursor-pointer" onClick={() => setOpenId(row.id)}>
                  <TableCell className="font-medium">{row.reference}</TableCell>
                  <TableCell>{row.supplierName}</TableCell>
                  <TableCell>{row.warehouse.code}</TableCell>
                  <TableCell>{row.expectedDeliveryDate ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(row.receivedQuantity)} / {formatQty(row.orderedQuantity)}</TableCell>
                  <TableCell><StatusBadge status={row.status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {openId && detail.data?.order && (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{detail.data.order.reference}</h3>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setOpenId(null)}>Close</Button>
              {data?.stockLedgerOn && items.find((row) => row.id === openId && (row.status === "APPROVED" || row.status === "PARTIALLY_RECEIVED")) && (
                <Button type="button" size="sm" onClick={() => setReceiving(true)}>
                  <PackageCheck className="mr-2 h-4 w-4" aria-hidden="true" /> Receive goods
                </Button>
              )}
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Ordered</TableHead>
                <TableHead className="text-right">Received</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.data.order.lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell>{line.productName}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(line.quantity)} {line.unit}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(line.receivedQuantity)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {detail.data.order.receipts.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Receipts</p>
              {detail.data.order.receipts.map((receipt) => (
                <p key={receipt.id} className="text-xs text-slate-600 dark:text-slate-300">
                  {receipt.reference} · {format(new Date(receipt.receivedAt), "d MMM yyyy, HH:mm")}{receipt.receivedBy ? ` · ${receipt.receivedBy}` : ""} —{" "}
                  {receipt.lines.map((line) => `${line.productName} ${formatQty(line.quantity)}`).join(", ")}
                </p>
              ))}
            </div>
          )}
          {receiving && (
            <ReceiveGoodsDialog
              open
              reference={detail.data.order.reference}
              lines={detail.data.order.lines}
              toleranceBps={detail.data.order.overDeliveryToleranceBps}
              endpoint={`${ROOT}/purchase-orders/${openId}/receipts`}
              onClose={() => setReceiving(false)}
              onDone={() => { void mutate(); void detail.mutate() }}
            />
          )}
        </Card>
      )}
    </div>
  )
}

export function WarehouseReturns() {
  const warehouses = useMyWarehouses()
  const [recording, setRecording] = useState(false)
  const [version, setVersion] = useState(0)
  const mine = warehouses.data?.items ?? []

  if (warehouses.data && mine.length === 0) return <NoWarehouse />
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Customer returns</h2>
          <p className="text-sm text-muted-foreground">Goods sent back by customers. Your warehouse executive or Super Admin approves each one.</p>
        </div>
        <Button type="button" onClick={() => setRecording(true)} disabled={mine.length === 0}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> Record return
        </Button>
      </div>
      <CustomerReturnList key={version} listEndpoint={`${ROOT}/returns`} />
      {recording && (
        <RecordReturnDialog
          open
          warehouses={mine}
          productEndpoint={PRODUCTS}
          endpoint={`${ROOT}/returns`}
          onClose={() => setRecording(false)}
          onDone={() => setVersion((current) => current + 1)}
        />
      )}
    </div>
  )
}
