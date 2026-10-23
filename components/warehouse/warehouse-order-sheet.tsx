"use client"

import { useRef, useState } from "react"
import useSWR from "swr"
import { format } from "date-fns"
import { CheckCircle2, Clock, Download, FileText, ImageIcon, Loader2, MapPin, Package, Receipt, StickyNote, Truck, Upload, X } from "lucide-react"

import { uploadDeliveryChallan } from "@/components/orders/delivery-challan"
import { OrderIntakeScreenshot } from "@/components/orders/order-intake-screenshot"
import { healthStyle, paymentStyle } from "@/components/warehouse/delivery-health-styles"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { toast } from "@/hooks/use-toast"
import { DELIVERY_CHALLAN_ACCEPT } from "@/lib/delivery-challan"
import { fetcher } from "@/lib/fetcher"
import type { FulfillmentStatus } from "@/lib/fulfillment-status"
import { TAX_INVOICE_ISSUE_STAGE } from "@/lib/invoice-policy"
import { formatPKR } from "@/lib/utils"
import { WAREHOUSE_STAGE_ACTION_LABELS, timelineUnavailableReason } from "@/lib/warehouse-orders"

/**
 * One order's picking sheet for the warehouse, and the one action it may take:
 * move the delivery a stage forward. Marking delivered offers an optional
 * challan; a delivered order with none can have one added later. Presentation
 * only — every rule is the server's (plans/OF-WAREHOUSE-warehouse-fulfilment-role.md).
 */

export type WarehouseOrderSheetData = {
  order: {
    id: number
    tid: string
    organizationName: string
    branchName: string
    status: string
    notes: string | null
    poNumber: string | null
    approvedAt: string | null
    deliveredAt: string | null
    stage: FulfillmentStatus
    stageLabel: string
    nextStage: FulfillmentStatus | null
    health: string | null
    healthLabel: string | null
    promisedAt: string | null
    /** An Order Desk order carrying the customer's screenshot. */
    hasIntakeScreenshot?: boolean
  }
  destination: {
    label: string | null
    address: string | null
    city: string | null
    province: string | null
    contactPerson: string | null
    contactPhone: string | null
    isBranchAddress: boolean
  }
  invoice: {
    invoiceNumber: string | null
    invoiceDate: string | null
    subtotalCents: number
    taxCents: number
    discountCents: number
    deliveryChargesCents: number
    totalCents: number
    refundAmountCents: number
    paymentStatus: string
    paidAt: string | null
  }
  lines: Array<{
    id: number
    productCode: string | null
    productName: string
    unit: string
    quantity: number
    priceCents: number
    taxCents: number
    amountCents: number
  }>
  challans: Array<{ id: number; fileName: string; contentType: string; uploadedAt: string; uploadedByRole: string | null }>
}

type TimelineData = { events: Array<{ key: string; label: string; at: string; by: string | null }> }

export const warehouseOrderKey = (orderId: number) => `/api/v1/warehouse/orders/${orderId}`

const money = (cents: number) => formatPKR(cents / 100)

function when(value: string | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "—" : format(date, "d MMM yyyy, h:mm a")
}

async function postJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(typeof data?.error === "string" ? data.error : "The request failed")
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Upload the chosen challan. If that fails, nothing else is sent, and the
 * message says so plainly — a failed upload must never read as a delivery.
 */
async function uploadOrExplain(orderId: number, file: File, mode: "deliver" | "add"): Promise<number> {
  try {
    return await uploadDeliveryChallan(orderId, file)
  } catch (uploadError) {
    const reason = uploadError instanceof Error ? uploadError.message : "The challan could not be uploaded"
    const outcome = mode === "deliver"
      ? "The order has NOT been marked delivered — try again, or remove the file to deliver without a challan."
      : "No challan was attached."
    throw new Error(`${reason}. ${outcome}`, { cause: uploadError })
  }
}

/**
 * Choosing an optional challan, then marking the order delivered with it or
 * without it, or (mode "add") attaching it to a delivered order. One primary
 * button whose action follows whether a file is chosen.
 */
function ChallanDialog({
  order,
  mode,
  onClose,
  onDone,
}: Readonly<{
  order: { id: number; tid: string }
  mode: "deliver" | "add"
  onClose: () => void
  onDone: () => void
}>) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const clearFile = () => {
    setFile(null)
    setProblem(null)
    if (inputRef.current) inputRef.current.value = ""
  }

  const run = async () => {
    if (busy || (mode === "add" && !file)) return
    setBusy(true)
    setProblem(null)
    try {
      const challanId = file ? await uploadOrExplain(order.id, file, mode) : null
      if (mode === "deliver") {
        await postJson(`/api/v1/warehouse/orders/${order.id}/progress`, {
          fulfillmentStatus: "DELIVERED",
          ...(challanId === null ? {} : { deliveryChallanId: challanId }),
        })
        toast({ title: "Order marked delivered", description: order.tid })
      } else {
        await postJson(`/api/v1/warehouse/orders/${order.id}/delivery-challan`, { deliveryChallanId: challanId })
        toast({ title: "Delivery challan added", description: order.tid })
      }
      onDone()
      onClose()
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The request failed")
    } finally {
      setBusy(false)
    }
  }

  let primaryLabel = "Upload and attach"
  if (mode === "deliver") primaryLabel = file ? "Upload and mark delivered" : "Mark delivered without challan"
  const PrimaryIcon = file ? Upload : CheckCircle2

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "deliver" ? "Mark order delivered" : "Add delivery challan"}</DialogTitle>
          <DialogDescription>
            Order <span className="break-all font-mono text-foreground">{order.tid}</span>
            {mode === "deliver"
              ? ". Attaching the signed delivery challan is optional."
              : " was delivered without a challan. Attach it now."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <p className="text-sm font-medium">
            Delivery challan{mode === "deliver" && <span className="font-normal text-muted-foreground"> (optional)</span>}
          </p>
          <input
            ref={inputRef}
            id="warehouse-challan-file"
            type="file"
            accept={DELIVERY_CHALLAN_ACCEPT}
            disabled={busy}
            className="peer sr-only"
            aria-describedby="warehouse-challan-help"
            onChange={(event) => {
              setProblem(null)
              setFile(event.target.files?.[0] ?? null)
            }}
          />
          {file ? (
            <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
              <FileText className="h-8 w-8 shrink-0 text-primary" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatSize(file.size)}</p>
              </div>
              <Button type="button" variant="ghost" size="icon" onClick={clearFile} disabled={busy} aria-label="Remove the chosen file">
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <label
              htmlFor="warehouse-challan-file"
              className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors hover:border-primary/50 hover:bg-muted/40 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Upload className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="text-sm font-medium">Choose the challan file</span>
              <span id="warehouse-challan-help" className="text-xs text-muted-foreground">
                A photo or scan (JPG, PNG, WebP) or a PDF, up to 4 MB.
              </span>
            </label>
          )}
          {problem && <p role="alert" className="text-sm text-rose-600">{problem}</p>}
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={() => { void run() }} disabled={busy || (mode === "add" && !file)}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PrimaryIcon className="mr-2 h-4 w-4" />}
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type LucideIcon = typeof Clock

function Section({
  icon: Icon,
  title,
  aside,
  children,
}: Readonly<{ icon: LucideIcon; title: string; aside?: React.ReactNode; children: React.ReactNode }>) {
  return (
    <section className="rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {title}
        </h3>
        {aside}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

function Fact({ label, value }: Readonly<{ label: string; value: React.ReactNode }>) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  )
}

function Row({ label, value, strong = false }: Readonly<{ label: string; value: React.ReactNode; strong?: boolean }>) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-1.5 ${strong ? "text-base font-semibold" : "text-sm"}`}>
      <span className={strong ? "" : "text-muted-foreground"}>{label}</span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  )
}

function Pill({ className, children }: Readonly<{ className: string; children: React.ReactNode }>) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>{children}</span>
}

/**
 * Fetch the invoice and save it, so a refusal (no invoice yet, out of reach)
 * shows as a message instead of a downloaded error page.
 */
async function downloadInvoice(orderId: number, tid: string): Promise<void> {
  const response = await fetch(`/api/v1/warehouse/orders/${orderId}/invoice`)
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(typeof data?.error === "string" ? data.error : "The invoice could not be downloaded")
  }
  const disposition = response.headers.get("Content-Disposition") ?? ""
  const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `invoice-${tid}.pdf`
  const url = URL.createObjectURL(await response.blob())
  try {
    const link = document.createElement("a")
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function WarehouseOrderSheet({
  orderId,
  onClose,
  onChanged,
}: Readonly<{ orderId: number | null; onClose: () => void; onChanged: () => void }>) {
  const { data, error, isLoading, mutate } = useSWR<WarehouseOrderSheetData>(
    orderId === null ? null : warehouseOrderKey(orderId),
    fetcher,
  )
  const { data: timeline, error: timelineError } = useSWR<TimelineData>(
    orderId === null ? null : `/api/v1/warehouse/orders/${orderId}/timeline`,
    fetcher,
    { shouldRetryOnError: false },
  )
  const [dialog, setDialog] = useState<"deliver" | "add" | null>(null)
  const [moving, setMoving] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const saveInvoice = async () => {
    if (!data || downloading) return
    setDownloading(true)
    try {
      await downloadInvoice(data.order.id, data.order.tid)
    } catch (caught) {
      toast({
        title: "Could not download the invoice",
        description: caught instanceof Error ? caught.message : "The request failed",
        variant: "destructive",
      })
    } finally {
      setDownloading(false)
    }
  }

  const refresh = () => {
    void mutate()
    onChanged()
  }

  const advance = async (next: FulfillmentStatus) => {
    if (!data || moving) return
    if (next === "DELIVERED") {
      setDialog("deliver")
      return
    }
    setMoving(true)
    try {
      await postJson(`/api/v1/warehouse/orders/${data.order.id}/progress`, { fulfillmentStatus: next })
      // This step issues the tax invoice, which goes out with the goods.
      toast({
        title: "Delivery progress updated",
        description: next === TAX_INVOICE_ISSUE_STAGE
          ? `${data.order.tid} · Tax invoice issued — download it to send with the goods`
          : data.order.tid,
      })
      refresh()
    } catch (caught) {
      toast({
        title: "Could not update the order",
        description: caught instanceof Error ? caught.message : "The request failed",
        variant: "destructive",
      })
    } finally {
      setMoving(false)
    }
  }

  const order = data?.order
  const next = order?.nextStage
  const delivered = order?.stage === "DELIVERED"
  const destinationLine = data
    ? [data.destination.address, data.destination.city, data.destination.province].filter(Boolean).join(", ")
    : ""
  const totalQuantity = data?.lines.reduce((sum, line) => sum + Number(line.quantity), 0) ?? 0
  const linesTotal = data?.lines.reduce((sum, line) => sum + line.amountCents, 0) ?? 0

  return (
    <Sheet open={orderId !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent className="w-full gap-0 overflow-y-auto bg-slate-50 p-0 sm:max-w-2xl dark:bg-slate-950">
        <SheetHeader className="sticky top-0 z-10 gap-3 border-b bg-background px-6 pb-4 pt-5">
          <div className="pr-8">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Order</p>
            <SheetTitle className="break-all font-mono text-lg">{order?.tid ?? "Loading…"}</SheetTitle>
            <SheetDescription className="mt-0.5">
              {order ? `Order ID ${order.id} · ${order.organizationName} · ${order.branchName}` : "Loading the picking sheet"}
            </SheetDescription>
          </div>
          {data && order && (
            <div className="flex flex-wrap items-center gap-2">
              <Pill className="bg-indigo-100 text-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-300">{order.stageLabel}</Pill>
              {order.healthLabel && <Pill className={healthStyle(order.health)}>{order.healthLabel}</Pill>}
              <Pill className={paymentStyle(data.invoice.paymentStatus)}>{data.invoice.paymentStatus}</Pill>
              <div className="ml-auto flex gap-2">
                {data.invoice.invoiceNumber && (
                  <Button size="sm" variant="outline" onClick={() => { void saveInvoice() }} disabled={downloading}>
                    {downloading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                    Download invoice
                  </Button>
                )}
                {delivered && data.challans.length === 0 && (
                  <Button size="sm" variant="outline" onClick={() => setDialog("add")}>
                    <Upload className="mr-2 h-4 w-4" /> Add delivery challan
                  </Button>
                )}
                {next && (
                  <Button size="sm" onClick={() => { void advance(next) }} disabled={moving}>
                    {moving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Truck className="mr-2 h-4 w-4" />}
                    {WAREHOUSE_STAGE_ACTION_LABELS[next as Exclude<FulfillmentStatus, "NOT_STARTED">]}
                  </Button>
                )}
              </div>
            </div>
          )}
        </SheetHeader>

        <div className="space-y-4 px-6 py-5">
          {isLoading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          )}
          {error && <p role="alert" className="text-sm text-destructive">This order could not be loaded.</p>}

          {data && order && (
            <>
              <Section icon={MapPin} title="Deliver to">
                <p className="text-sm font-medium">
                  {data.destination.label ?? order.branchName}
                  {data.destination.isBranchAddress && <span className="ml-1 font-normal text-muted-foreground">(branch address)</span>}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{destinationLine || "No address on file"}</p>
                {(data.destination.contactPerson || data.destination.contactPhone) && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    Contact: {[data.destination.contactPerson, data.destination.contactPhone].filter(Boolean).join(" · ")}
                  </p>
                )}
                <dl className="mt-4 grid grid-cols-2 gap-4 border-t pt-4 sm:grid-cols-3">
                  <Fact label="Approved on" value={when(order.approvedAt)} />
                  <Fact label="Promised by" value={when(order.promisedAt)} />
                  <Fact label="Delivered on" value={when(order.deliveredAt)} />
                </dl>
              </Section>

              {order.notes && (
                <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/40">
                  <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                  <div>
                    <p className="font-medium text-amber-900 dark:text-amber-200">Notes from the branch</p>
                    <p className="mt-0.5 whitespace-pre-wrap text-amber-900/90 dark:text-amber-100">{order.notes}</p>
                  </div>
                </div>
              )}

              {order.hasIntakeScreenshot && (
                <Section icon={ImageIcon} title="Customer's order screenshot">
                  <p className="mb-3 text-xs text-muted-foreground">
                    Attached by Apricart&apos;s Order Desk when it entered this order from the customer&apos;s message.
                  </p>
                  <OrderIntakeScreenshot
                    src={`/api/v1/warehouse/orders/${order.id}/intake-screenshot`}
                    orderTid={order.tid}
                  />
                </Section>
              )}

              <Section
                icon={Package}
                title="Picking list"
                aside={<span className="text-xs text-muted-foreground">{data.lines.length} item{data.lines.length === 1 ? "" : "s"} · {totalQuantity} units</span>}
              >
                <div className="-m-4 overflow-x-auto">
                  <table className="w-full min-w-[480px] text-sm">
                    <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2 font-medium">Item</th>
                        <th className="px-4 py-2 text-right font-medium">Qty</th>
                        <th className="px-4 py-2 text-right font-medium">Unit price</th>
                        <th className="px-4 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.lines.map((line) => (
                        <tr key={line.id} className="border-t">
                          <td className="px-4 py-2.5">
                            <div className="font-medium">{line.productName}</div>
                            <div className="font-mono text-xs text-muted-foreground">{line.productCode ?? "—"}</div>
                          </td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                            {line.quantity} <span className="text-muted-foreground">{line.unit}</span>
                          </td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">{money(line.priceCents)}</td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-right font-medium tabular-nums">{money(line.amountCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t bg-muted/20">
                        <td className="px-4 py-2.5 text-xs text-muted-foreground" colSpan={3}>Lines total</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums">{money(linesTotal)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Section>

              <Section icon={Receipt} title="Invoice">
                <dl className="mb-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Fact label="Invoice number" value={data.invoice.invoiceNumber ?? "—"} />
                  <Fact label="Invoice date" value={data.invoice.invoiceDate ?? "—"} />
                  <Fact label="PO number" value={order.poNumber ?? "—"} />
                </dl>
                <div className="divide-y border-t">
                  <Row label="Subtotal" value={money(data.invoice.subtotalCents)} />
                  <Row label="Tax" value={money(data.invoice.taxCents)} />
                  {data.invoice.discountCents > 0 && <Row label="Discount" value={`− ${money(data.invoice.discountCents)}`} />}
                  {data.invoice.deliveryChargesCents > 0 && <Row label="Delivery charges" value={money(data.invoice.deliveryChargesCents)} />}
                  {data.invoice.refundAmountCents > 0 && <Row label="Refunded" value={`− ${money(data.invoice.refundAmountCents)}`} />}
                  <Row label="Total" value={money(data.invoice.totalCents)} strong />
                  <Row
                    label="Payment"
                    value={(
                      <span className="inline-flex items-center gap-2">
                        <Pill className={paymentStyle(data.invoice.paymentStatus)}>{data.invoice.paymentStatus}</Pill>
                        {data.invoice.paidAt && <span className="text-xs text-muted-foreground">{when(data.invoice.paidAt)}</span>}
                      </span>
                    )}
                  />
                </div>
              </Section>

              <Section icon={FileText} title="Delivery challan">
                {data.challans.length === 0 ? (
                  <div className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
                    {delivered
                      ? "Delivered without a challan. Use “Add delivery challan” above to attach it."
                      : "No challan yet. You can attach one when you mark the order delivered."}
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {data.challans.map((challan) => (
                      <li key={challan.id}>
                        <a
                          href={`/api/v1/warehouse/orders/${order.id}/delivery-challan/${challan.id}/file`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/50"
                        >
                          <FileText className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{challan.fileName}</span>
                            <span className="block text-xs text-muted-foreground">Uploaded {when(challan.uploadedAt)}</span>
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section icon={Clock} title="Timeline">
                {timelineError && (
                  <p className="text-sm text-muted-foreground">{timelineUnavailableReason(order.approvedAt)}</p>
                )}
                {!timeline && !timelineError && <p className="text-sm text-muted-foreground">Loading…</p>}
                {timeline && (
                  <ol className="relative ml-1.5 space-y-4 border-l pl-5" aria-label="Order timeline">
                    {timeline.events.map((event, index) => (
                      <li key={event.key} className="relative">
                        <span
                          className={`absolute -left-[27px] top-1 h-3 w-3 rounded-full ring-4 ring-card ${index === timeline.events.length - 1 ? "bg-primary" : "bg-slate-300 dark:bg-slate-600"}`}
                          aria-hidden="true"
                        />
                        <p className="text-sm font-medium">{event.label}</p>
                        <p className="text-xs text-muted-foreground">{when(event.at)}{event.by ? ` · ${event.by}` : ""}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </Section>
            </>
          )}
        </div>

        {dialog && order && (
          <ChallanDialog
            order={{ id: order.id, tid: order.tid }}
            mode={dialog}
            onClose={() => setDialog(null)}
            onDone={refresh}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}
