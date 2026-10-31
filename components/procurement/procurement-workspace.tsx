"use client"

import { useState } from "react"
import { useSession } from "next-auth/react"
import useSWR from "swr"
import { format } from "date-fns"
import { Loader2, Plus } from "lucide-react"

import { CustomerReturnList } from "@/components/procurement/customer-returns"
import {
  PurchaseOrderDetailDialog,
  PurchaseOrderFormDialog,
  type PurchaseOrderDraft,
  type Supplier,
  type Warehouse,
} from "@/components/procurement/purchase-order-dialogs"
import { ListState, ReasonDialog, StatusBadge, formatQty, money, sendJson } from "@/components/procurement/procurement-shared"
import { RequisitionDialog } from "@/components/procurement/requisition-dialog"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import { PURCHASE_ORDER_STATUSES, PURCHASE_ORDER_STATUS_LABELS, tolerancePercent } from "@/lib/procurement"
import {
  canAdministerCustomerReturns,
  canApproveInvoiceExceptions,
  canChangeProcurementSettings,
  canDecideSupplierInvoices,
  canManageProcurement,
} from "@/lib/procurement-access"

/**
 * The purchasing page (`/procurement`): purchase orders, requisitions,
 * suppliers, supplier invoices, shortages, customer returns and the
 * over-delivery setting — each tab and control shown as the role allows
 * (`lib/procurement-access.ts`), and every one checked again on the server.
 * See plans/OF-PROCUREMENT-purchasing.md.
 */

const ROOT = "/api/v1/procurement"

function useReferenceData() {
  const suppliers = useSWR<{ items: Supplier[] }>(`${ROOT}/suppliers`, fetcher)
  const warehouses = useSWR<{ items: Warehouse[]; stockLedgerOn: boolean }>(`${ROOT}/warehouses`, fetcher)
  return {
    suppliers: suppliers.data?.items ?? [],
    warehouses: warehouses.data?.items ?? [],
    stockLedgerOn: warehouses.data?.stockLedgerOn ?? false,
    refreshSuppliers: suppliers.mutate,
  }
}

export function ProcurementWorkspace() {
  const { data: session } = useSession()
  const role = (session?.user as { role?: string } | undefined)?.role
  const manage = canManageProcurement(role)
  const reference = useReferenceData()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-white">Procurement</h1>
        <p className="text-sm text-muted-foreground">Buying for Apricart&apos;s warehouses: purchase orders, receipts and supplier invoices.</p>
      </div>
      {!reference.stockLedgerOn && (
        <Card className="border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Stock is still counted globally, so goods cannot be received into a warehouse yet. Purchase orders, approvals and
          invoices work as usual; receiving opens when stock is switched to per-warehouse counting.
        </Card>
      )}
      <Tabs defaultValue="orders" className="space-y-4">
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="orders">Purchase orders</TabsTrigger>
          {manage && <TabsTrigger value="requisitions">Requisitions</TabsTrigger>}
          <TabsTrigger value="invoices">Supplier invoices</TabsTrigger>
          <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
          {manage && <TabsTrigger value="shortages">Shortages</TabsTrigger>}
          {canAdministerCustomerReturns(role) && <TabsTrigger value="returns">Customer returns</TabsTrigger>}
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="orders"><PurchaseOrdersTab role={role} {...reference} /></TabsContent>
        {manage && <TabsContent value="requisitions"><RequisitionsTab {...reference} /></TabsContent>}
        <TabsContent value="invoices"><SupplierInvoicesTab role={role} /></TabsContent>
        <TabsContent value="suppliers"><SuppliersTab manage={manage} suppliers={reference.suppliers} refresh={() => { void reference.refreshSuppliers() }} /></TabsContent>
        {manage && <TabsContent value="shortages"><ShortagesTab /></TabsContent>}
        {canAdministerCustomerReturns(role) && (
          <TabsContent value="returns">
            <CustomerReturnList listEndpoint={`${ROOT}/returns`} decideEndpoint={(id) => `${ROOT}/returns/${id}`} />
          </TabsContent>
        )}
        <TabsContent value="settings"><SettingsTab canChange={canChangeProcurementSettings(role)} /></TabsContent>
      </Tabs>
    </div>
  )
}

type ReferenceProps = ReturnType<typeof useReferenceData>

type PurchaseOrderRow = {
  id: number
  reference: string
  status: string
  supplier: { name: string }
  warehouse: { code: string }
  expectedDeliveryDate: string | null
  totalCents: number
  createdAt: string
}

function PurchaseOrdersTab({ role, suppliers, warehouses, stockLedgerOn }: Readonly<{ role: string | undefined } & ReferenceProps>) {
  const [status, setStatus] = useState<string>("all")
  const [page, setPage] = useState(1)
  const query = new URLSearchParams({ page: String(page), ...(status === "all" ? {} : { status }) })
  const { data, error, isLoading, mutate } = useSWR<{ items: PurchaseOrderRow[]; total: number; pageSize: number }>(
    `${ROOT}/purchase-orders?${query}`,
    fetcher,
  )
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)
  const items = data?.items ?? []
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <Label htmlFor="po-status-filter">Status</Label>
          <Select value={status} onValueChange={(value) => { setStatus(value); setPage(1) }}>
            <SelectTrigger id="po-status-filter" className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {PURCHASE_ORDER_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>{PURCHASE_ORDER_STATUS_LABELS[value]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {canManageProcurement(role) && (
          <Button type="button" onClick={() => setCreating(true)}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> New purchase order
          </Button>
        )}
      </div>
      <ListState isLoading={isLoading} error={error} empty={!isLoading && !error && items.length === 0} emptyText="No purchase orders." />
      {items.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Purchase order</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>Expected</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((row) => (
                <TableRow key={row.id} className="cursor-pointer" onClick={() => setOpenId(row.id)}>
                  <TableCell className="font-medium">{row.reference}</TableCell>
                  <TableCell>{row.supplier.name}</TableCell>
                  <TableCell>{row.warehouse.code}</TableCell>
                  <TableCell>{row.expectedDeliveryDate ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.totalCents)}</TableCell>
                  <TableCell><StatusBadge status={row.status} /></TableCell>
                  <TableCell>{format(new Date(row.createdAt), "d MMM yyyy")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
          <span>Page {page} of {totalPages}</span>
          <Button type="button" size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      )}
      {creating && (
        <PurchaseOrderFormDialog
          open
          draft={{ lines: [] }}
          suppliers={suppliers}
          warehouses={warehouses}
          onClose={() => setCreating(false)}
          onSaved={(id) => { void mutate(); setOpenId(id) }}
        />
      )}
      {openId && (
        <PurchaseOrderDetailDialog
          id={openId}
          role={role}
          stockLedgerOn={stockLedgerOn}
          suppliers={suppliers}
          warehouses={warehouses}
          onClose={() => setOpenId(null)}
          onChanged={() => { void mutate() }}
        />
      )}
    </div>
  )
}

type RequisitionRow = {
  id: number
  reference: string
  warehouse: { id: number; code: string; name: string }
  status: string
  note: string | null
  requestedBy: string | null
  decisionReason: string | null
  purchaseOrderReference: string | null
  createdAt: string
  lines: Array<{ globalProductId: number; productName: string; unit: string; allowDecimalQuantity: boolean; quantity: number }>
}

function RequisitionsTab({ suppliers, warehouses }: Readonly<ReferenceProps>) {
  const [status, setStatus] = useState("SUBMITTED")
  const { data, error, isLoading, mutate } = useSWR<{ items: RequisitionRow[] }>(
    `${ROOT}/requisitions${status === "all" ? "" : `?status=${status}`}`,
    fetcher,
  )
  const [raising, setRaising] = useState(false)
  const [converting, setConverting] = useState<PurchaseOrderDraft | null>(null)
  const [rejecting, setRejecting] = useState<RequisitionRow | null>(null)
  const items = data?.items ?? []

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <Label htmlFor="requisition-status-filter">Status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id="requisition-status-filter" className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="SUBMITTED">Waiting</SelectItem>
              <SelectItem value="CONVERTED">Ordered</SelectItem>
              <SelectItem value="REJECTED">Rejected</SelectItem>
              <SelectItem value="CANCELLED">Cancelled</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="button" variant="outline" onClick={() => setRaising(true)}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> Raise requisition
        </Button>
      </div>
      <ListState isLoading={isLoading} error={error} empty={!isLoading && !error && items.length === 0} emptyText="No requisitions." />
      {items.map((row) => (
        <Card key={row.id} className="space-y-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{row.reference}</span>
              <StatusBadge status={row.status} />
              <span className="text-xs text-muted-foreground">
                {row.warehouse.code} · {format(new Date(row.createdAt), "d MMM yyyy")}{row.requestedBy ? ` · ${row.requestedBy}` : ""}
                {row.purchaseOrderReference ? ` → ${row.purchaseOrderReference}` : ""}
              </span>
            </div>
            {row.status === "SUBMITTED" && (
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setRejecting(row)}>Reject</Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setConverting({
                    requisitionId: row.id,
                    warehouseId: row.warehouse.id,
                    lines: row.lines.map((line) => ({
                      product: { id: line.globalProductId, name: line.productName, unit: line.unit, allowDecimalQuantity: line.allowDecimalQuantity },
                      quantity: String(line.quantity),
                      unitCost: "",
                      taxPercent: "0",
                    })),
                  })}
                >
                  Create purchase order
                </Button>
              </div>
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
          warehouses={warehouses.filter((warehouse) => warehouse.status === "ACTIVE")}
          productEndpoint={`${ROOT}/products`}
          endpoint={`${ROOT}/requisitions`}
          onClose={() => setRaising(false)}
          onDone={() => { void mutate() }}
        />
      )}
      {converting && (
        <PurchaseOrderFormDialog
          open
          draft={converting}
          suppliers={suppliers}
          warehouses={warehouses}
          onClose={() => setConverting(null)}
          onSaved={() => { void mutate() }}
        />
      )}
      {rejecting && (
        <ReasonDialog
          open
          title={`Reject ${rejecting.reference}`}
          confirmLabel="Reject"
          onClose={() => setRejecting(null)}
          onConfirm={async (reason) => {
            await sendJson(`${ROOT}/requisitions/${rejecting.id}`, "PATCH", { action: "reject", reason })
            toast({ title: "Requisition rejected" })
            await mutate()
          }}
        />
      )}
    </div>
  )
}

type InvoiceRow = {
  id: number
  invoiceNumber: string
  invoiceDate: string
  supplier: { name: string }
  purchaseOrderReference: string
  subtotalCents: number
  taxCents: number
  totalCents: number
  matchStatus: string
  status: string
  decisionReason: string | null
  paymentReference: string | null
  lines: Array<{ purchaseOrderLineId: number; productName: string; quantity: number; unitCostCents: number; poUnitCostCents: number; receivedQuantity: number; lineTotalCents: number }>
}

type InvoiceAction = { row: InvoiceRow; action: "approve" | "reject" | "pay" }

function SupplierInvoicesTab({ role }: Readonly<{ role: string | undefined }>) {
  const [status, setStatus] = useState("RECORDED")
  const { data, error, isLoading, mutate } = useSWR<{ items: InvoiceRow[] }>(
    `${ROOT}/supplier-invoices${status === "all" ? "" : `?status=${status}`}`,
    fetcher,
  )
  const [acting, setActing] = useState<InvoiceAction | null>(null)
  const decide = canDecideSupplierInvoices(role)
  const items = data?.items ?? []

  const copy = (entry: InvoiceAction) => {
    if (entry.action === "pay") return { title: `Mark ${entry.row.invoiceNumber} paid`, confirm: "Mark paid", optional: true }
    if (entry.action === "reject") return { title: `Reject ${entry.row.invoiceNumber}`, confirm: "Reject", optional: false }
    const exception = entry.row.matchStatus === "EXCEPTION"
    return { title: `Approve ${entry.row.invoiceNumber}`, confirm: "Approve for payment", optional: !exception }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="invoice-status-filter">Status</Label>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger id="invoice-status-filter" className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="RECORDED">Waiting for approval</SelectItem>
            <SelectItem value="APPROVED">Approved</SelectItem>
            <SelectItem value="PAID">Paid</SelectItem>
            <SelectItem value="REJECTED">Rejected</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">Invoices are recorded from a purchase order. A line matches when it is within what was received, at the order&apos;s unit cost.</p>
      <ListState isLoading={isLoading} error={error} empty={!isLoading && !error && items.length === 0} emptyText="No supplier invoices." />
      {items.map((row) => {
        const exception = row.matchStatus === "EXCEPTION"
        return (
          <Card key={row.id} className="space-y-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{row.invoiceNumber}</span>
                <StatusBadge status={row.matchStatus} />
                <StatusBadge status={row.status} />
                <span className="text-xs text-muted-foreground">{row.supplier.name} · {row.purchaseOrderReference} · {row.invoiceDate}</span>
              </div>
              <span className="font-semibold tabular-nums">{money(row.totalCents)}</span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Invoiced</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Unit cost</TableHead>
                  <TableHead className="text-right">PO unit cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {row.lines.map((line) => (
                  <TableRow key={line.purchaseOrderLineId}>
                    <TableCell>{line.productName}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQty(line.quantity)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQty(line.receivedQuantity)}</TableCell>
                    <TableCell className={`text-right tabular-nums ${line.unitCostCents === line.poUnitCostCents ? "" : "font-semibold text-red-700"}`}>{money(line.unitCostCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(line.poUnitCostCents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {row.decisionReason && <p className="text-xs text-muted-foreground">Reason: {row.decisionReason}</p>}
            {row.paymentReference && <p className="text-xs text-muted-foreground">Payment reference: {row.paymentReference}</p>}
            {decide && (
              <div className="flex flex-wrap justify-end gap-2">
                {row.status === "RECORDED" && (
                  <>
                    <Button type="button" size="sm" variant="outline" onClick={() => setActing({ row, action: "reject" })}>Reject</Button>
                    {(!exception || canApproveInvoiceExceptions(role)) && (
                      <Button type="button" size="sm" onClick={() => setActing({ row, action: "approve" })}>
                        {exception ? "Approve despite mismatch" : "Approve for payment"}
                      </Button>
                    )}
                    {exception && !canApproveInvoiceExceptions(role) && (
                      <span className="text-xs text-muted-foreground">Does not match — only Super Admin may approve it.</span>
                    )}
                  </>
                )}
                {row.status === "APPROVED" && (
                  <Button type="button" size="sm" onClick={() => setActing({ row, action: "pay" })}>Mark paid</Button>
                )}
              </div>
            )}
          </Card>
        )
      })}
      {acting && (
        <ReasonDialog
          open
          title={copy(acting).title}
          description={acting.action === "pay" ? "Enter the payment reference in the box (optional)." : undefined}
          confirmLabel={copy(acting).confirm}
          optional={copy(acting).optional}
          onClose={() => setActing(null)}
          onConfirm={async (text) => {
            const body = acting.action === "pay"
              ? { action: "pay", paymentReference: text || null }
              : { action: acting.action, ...(text ? { reason: text } : {}) }
            await sendJson(`${ROOT}/supplier-invoices/${acting.row.id}`, "PATCH", body)
            toast({ title: "Invoice updated" })
            await mutate()
          }}
        />
      )}
    </div>
  )
}

type SupplierRow = Supplier & { contactName: string | null; phone: string | null; email: string | null; address: string | null; ntn: string | null }

function SuppliersTab({ manage, suppliers, refresh }: Readonly<{ manage: boolean; suppliers: readonly Supplier[]; refresh: () => void }>) {
  const [editing, setEditing] = useState<SupplierRow | "new" | null>(null)
  const rows = suppliers as readonly SupplierRow[]

  return (
    <div className="space-y-3">
      {manage && (
        <div className="flex justify-end">
          <Button type="button" onClick={() => setEditing("new")}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> Add supplier
          </Button>
        </div>
      )}
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No suppliers yet.</p>}
      {rows.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>NTN</TableHead>
                <TableHead>Status</TableHead>
                {manage && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell>{row.contactName ?? "—"}</TableCell>
                  <TableCell>{row.phone ?? "—"}</TableCell>
                  <TableCell>{row.ntn ?? "—"}</TableCell>
                  <TableCell>{row.status === "ACTIVE" ? "Active" : "Inactive"}</TableCell>
                  {manage && (
                    <TableCell className="text-right">
                      <Button type="button" size="sm" variant="outline" onClick={() => setEditing(row)}>Edit</Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {editing && <SupplierDialog supplier={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  )
}

function SupplierDialog({ supplier, onClose, onSaved }: Readonly<{ supplier: SupplierRow | null; onClose: () => void; onSaved: () => void }>) {
  const [form, setForm] = useState({
    name: supplier?.name ?? "",
    contactName: supplier?.contactName ?? "",
    phone: supplier?.phone ?? "",
    email: supplier?.email ?? "",
    address: supplier?.address ?? "",
    ntn: supplier?.ntn ?? "",
    status: supplier?.status ?? "ACTIVE",
  })
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }))

  const submit = async () => {
    setSubmitting(true)
    setFailure(null)
    const { status, ...fields } = form
    try {
      if (supplier) await sendJson(`${ROOT}/suppliers/${supplier.id}`, "PATCH", { ...fields, status })
      else await sendJson(`${ROOT}/suppliers`, "POST", fields)
      toast({ title: supplier ? "Supplier saved" : "Supplier added" })
      onSaved()
      onClose()
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{supplier ? "Edit supplier" : "Add supplier"}</DialogTitle>
          <DialogDescription>An inactive supplier keeps its history and takes no new purchase order.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="supplier-name">Name</Label>
            <Input id="supplier-name" value={form.name} onChange={set("name")} maxLength={200} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="supplier-contact">Contact person</Label>
            <Input id="supplier-contact" value={form.contactName} onChange={set("contactName")} maxLength={200} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="supplier-phone">Phone</Label>
            <Input id="supplier-phone" value={form.phone} onChange={set("phone")} maxLength={32} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="supplier-email">Email</Label>
            <Input id="supplier-email" type="email" value={form.email} onChange={set("email")} maxLength={255} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="supplier-ntn">NTN</Label>
            <Input id="supplier-ntn" value={form.ntn} onChange={set("ntn")} maxLength={64} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="supplier-address">Address</Label>
            <Input id="supplier-address" value={form.address} onChange={set("address")} maxLength={500} />
          </div>
          {supplier && (
            <div className="space-y-1">
              <Label htmlFor="supplier-status">Status</Label>
              <Select value={form.status} onValueChange={(value) => setForm((current) => ({ ...current, status: value }))}>
                <SelectTrigger id="supplier-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="INACTIVE">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        {failure && <p className="text-sm text-red-600" role="alert">{failure}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={form.name.trim().length < 2 || submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type ShortageRow = {
  warehouseId: number | null
  warehouseCode: string | null
  globalProductId: number
  productName: string
  productCode: string
  unit: string
  onHand: number
  reserved: number
  onOrder: number
  shortfall: number
}

function ShortagesTab() {
  const { data, error, isLoading } = useSWR<{ items: ShortageRow[]; stockLedgerOn: boolean }>(`${ROOT}/shortages`, fetcher)
  const items = data?.items ?? []
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Where open orders need more than a warehouse holds, and what is already on order. Orders at a branch with no warehouse are shown under &ldquo;No warehouse&rdquo;.
      </p>
      <ListState isLoading={isLoading} error={error} empty={!isLoading && !error && items.length === 0} emptyText="No shortages." />
      {items.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Warehouse</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">Reserved</TableHead>
                <TableHead className="text-right">On order</TableHead>
                <TableHead className="text-right">Still short</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((row) => (
                <TableRow key={`${row.warehouseId ?? "none"}-${row.globalProductId}`}>
                  <TableCell>{row.warehouseCode ?? "No warehouse"}</TableCell>
                  <TableCell>{row.productName} <span className="text-xs text-muted-foreground">{row.productCode}</span></TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(row.onHand)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(row.reserved)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(row.onOrder)}</TableCell>
                  <TableCell className={`text-right tabular-nums ${row.shortfall > 0 ? "font-semibold text-red-700" : ""}`}>{formatQty(row.shortfall)} {row.unit}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}

function SettingsTab({ canChange }: Readonly<{ canChange: boolean }>) {
  const { data, mutate } = useSWR<{ overDeliveryToleranceBps: number; updatedAt: string | null }>(`${ROOT}/settings`, fetcher)
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)
  const current = data ? tolerancePercent(data.overDeliveryToleranceBps) : null

  const save = async () => {
    setSaving(true)
    try {
      await sendJson(`${ROOT}/settings`, "PUT", { overDeliveryTolerancePercent: Number(value) })
      toast({ title: "Setting saved", description: "It applies to purchase orders approved from now on." })
      setValue("")
      await mutate()
    } catch (caught) {
      toast({ title: "Not saved", description: caught instanceof Error ? caught.message : "Please try again.", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="max-w-lg space-y-3 p-4">
      <div>
        <h2 className="font-semibold">Over-delivery allowance</h2>
        <p className="text-sm text-muted-foreground">
          How much more than ordered a warehouse may receive on a line. Each purchase order keeps the allowance it was approved with.
        </p>
      </div>
      <p className="text-sm">Current: <strong>{current === null ? "…" : `${current}%`}</strong></p>
      {canChange && (
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="tolerance-percent">New allowance (%)</Label>
            <Input id="tolerance-percent" type="number" min={0} max={100} step="0.01" value={value} onChange={(event) => setValue(event.target.value)} className="w-32" />
          </div>
          <Button type="button" onClick={save} disabled={value.trim() === "" || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Save
          </Button>
        </div>
      )}
    </Card>
  )
}
