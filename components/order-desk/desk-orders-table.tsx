"use client"

import { useState } from "react"
import useSWR from "swr"
import { format } from "date-fns"
import { ArrowRight, Building2, ChevronDown, ChevronUp, ImageIcon, Inbox, Loader2, PackageCheck, Search, UserRound } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { PaymentStatusBadge } from "@/components/orders/payment-status-badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useDebounce } from "@/hooks/use-debounce"
import { toast } from "@/hooks/use-toast"
import {
  CancelDeskOrderDialog,
  EditDeskOrderDialog,
  RefundDeskOrderDialog,
  ResubmitDeskOrderDialog,
  type DeskOrder,
} from "@/components/order-desk/desk-order-dialogs"
import { CHANNEL_META, STAGE_META, StagePill, TAB_LABELS } from "@/components/order-desk/desk-theme"
import { fetcher } from "@/lib/fetcher"
import { FULFILLMENT_STATUSES, FULFILLMENT_STATUS_LABELS, normalizeFulfillmentStatus } from "@/lib/fulfillment-status"
import { PAYMENT_STATUS_LABELS, type PaymentStatus } from "@/lib/payment-status"
import {
  DESK_ORDER_STATUS_FILTERS,
  deskOrderStage,
  type DeskOrderCounts,
  type DeskOrderStatusFilter,
} from "@/lib/order-desk-query"
import { formatQuantity } from "@/lib/quantity"
import { cn, formatPKR } from "@/lib/utils"

export const DESK_ORDERS_KEY_PREFIX = "/api/v1/order-desk/orders"

type DeskOrderPage = {
  items: DeskOrder[]
  counts: DeskOrderCounts
  pagination: { page: number; limit: number; total: number; totalPages: number }
}

type Target = { id: number; name: string; branches: { id: number; name: string }[] }

const ALL = "all"

const EMPTY_MESSAGES: Record<DeskOrderStatusFilter, string> = {
  awaiting_approval: "No orders are waiting for approval.",
  awaiting_delivery: "No orders are waiting for delivery.",
  ready_to_fulfil: "Nothing to fulfil right now. Delivered orders appear here.",
  fulfilled: "No fulfilled orders yet.",
  rejected: "No rejected orders.",
  cancelled: "No cancelled orders.",
  all: "No orders yet. Create one from the New order tab.",
}

function displayDate(value: string | null) {
  return value ? format(new Date(value), "dd MMM yyyy, HH:mm") : "—"
}

type OpenDialog =
  | { kind: "fulfil"; order: DeskOrder }
  | { kind: "edit"; order: DeskOrder }
  | { kind: "cancel"; order: DeskOrder }
  | { kind: "resubmit"; order: DeskOrder }
  | { kind: "refund"; order: DeskOrder }
  | null

/**
 * Delivery as five steps — the four Super Admin records, then the desk's own
 * fulfilment — so where an order stands, and who it is waiting on, is visible
 * at a glance.
 */
function DeliveryTracker({ order }: Readonly<{ order: DeskOrder }>) {
  const steps = [...FULFILLMENT_STATUSES.map((status) => FULFILLMENT_STATUS_LABELS[status]), "Fulfilled"]
  const fulfilled = deskOrderStage(order) === "fulfilled"
  const reached = fulfilled ? steps.length - 1 : FULFILLMENT_STATUSES.indexOf(normalizeFulfillmentStatus(order.fulfillmentStatus))
  return (
    <ol className="flex items-center gap-1" aria-label={`Delivery progress: ${steps[reached]}`}>
      {steps.map((label, index) => {
        const done = index <= reached
        return (
          <li key={label} className="flex min-w-0 flex-1 flex-col gap-1">
            <span className={cn("h-1.5 rounded-full", done ? (fulfilled ? "bg-emerald-500" : "bg-indigo-500") : "bg-slate-200 dark:bg-slate-700")} />
            <span className={cn("truncate text-[11px]", index === reached ? "font-medium text-foreground" : "text-muted-foreground")}>
              {label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function OrderCard({
  order,
  busy,
  onAction,
}: Readonly<{ order: DeskOrder; busy: boolean; onAction: (dialog: NonNullable<OpenDialog>) => void }>) {
  const [open, setOpen] = useState(false)
  const stage = deskOrderStage(order)
  const channel = order.intakeChannel ? CHANNEL_META[order.intakeChannel] : null
  const ChannelIcon = channel?.icon

  return (
    <article className={cn("rounded-lg border bg-card shadow-sm", stage === "ready_to_fulfil" && "border-indigo-200 dark:border-indigo-900")}>
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">{order.tid}</h3>
              <StagePill stage={stage} />
              {stage === "fulfilled" && <PaymentStatusBadge order={order} />}
              {order.status.toUpperCase() === "REFUNDED" && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">Fully refunded</span>
              )}
              {order.returnedForCorrectionAt && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                  Returned for correction
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Entered {displayDate(order.createdAt)} by {order.enteredBy ?? "—"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold">{formatPKR(order.totalCents / 100)}</p>
            {order.refundedCents > 0 && (
              <p className="text-xs text-muted-foreground">Refunded {formatPKR(order.refundedCents / 100)}</p>
            )}
            {order.pendingRefundCents > 0 && (
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                Refund awaiting approval {formatPKR(order.pendingRefundCents / 100)}
              </p>
            )}
          </div>
        </div>

        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="flex items-start gap-2">
            <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate font-medium">{order.organizationName ?? "—"}</p>
              <p className="truncate text-muted-foreground">{order.branchName ?? "—"}</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            {ChannelIcon
              ? <ChannelIcon className={cn("mt-0.5 h-4 w-4 shrink-0", channel?.tone)} aria-hidden="true" />
              : <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            <div className="min-w-0">
              <p className="font-medium">{channel?.label ?? "—"}</p>
              <p className="truncate text-muted-foreground" title={order.intakeReference ?? ""}>{order.intakeReference ?? ""}</p>
            </div>
          </div>
        </div>

        {(stage === "awaiting_delivery" || stage === "ready_to_fulfil" || stage === "fulfilled") && <DeliveryTracker order={order} />}
        {order.returnedForCorrectionAt && order.correctionRequestNote && (
          <p className="whitespace-pre-line rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            <span className="font-medium">The executive asks: </span>{order.correctionRequestNote}
          </p>
        )}
        {stage === "rejected" && order.rejectionReason && (
          <p className="rounded-md bg-muted/50 p-2 text-sm text-muted-foreground">
            Rejected — {order.rejectionReason}
          </p>
        )}
        {stage === "cancelled" && order.cancellationReason && (
          <p className="rounded-md bg-muted/50 p-2 text-sm text-muted-foreground">
            Cancelled {displayDate(order.cancelledAt)} — {order.cancellationReason}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/20 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 font-medium text-indigo-700 hover:underline dark:text-indigo-300"
          >
            {open ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
            {open ? "Hide" : "Show"} {order.items.length} item{order.items.length === 1 ? "" : "s"}
          </button>
          {order.hasAttachment && (
            <a
              href={`/api/v1/order-desk/orders/${order.id}/attachment`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
            >
              <ImageIcon className="h-4 w-4" aria-hidden="true" /> Screenshot
            </a>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {stage === "awaiting_approval" && !order.returnedForCorrectionAt && (
            <span className="text-xs text-muted-foreground">Waiting for an Apricart Executive to approve</span>
          )}
          {stage === "awaiting_delivery" && (
            <span className="text-xs text-muted-foreground">Waiting for Super Admin to record delivery</span>
          )}
          {order.canCancel && (
            <Button
              size="sm"
              variant="ghost"
              className="text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:text-rose-400 dark:hover:bg-rose-950/40"
              onClick={() => onAction({ kind: "cancel", order })}
            >
              Cancel order
            </Button>
          )}
          {order.canEdit && (
            <Button size="sm" variant="outline" onClick={() => onAction({ kind: "edit", order })}>Edit</Button>
          )}
          {order.canResubmit && (
            <Button size="sm" onClick={() => onAction({ kind: "resubmit", order })}>Resubmit for approval</Button>
          )}
          {order.canRequestRefund && (
            <Button size="sm" variant="outline" onClick={() => onAction({ kind: "refund", order })}>Request refund</Button>
          )}
          {order.canFulfil && (
            <Button size="sm" disabled={busy} onClick={() => onAction({ kind: "fulfil", order })}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" /> : <PackageCheck className="mr-1 h-4 w-4" aria-hidden="true" />}
              Fulfil
            </Button>
          )}
        </div>
      </div>

      {open && (
        <div className="border-t px-4 py-3">
          <ul className="divide-y text-sm">
            {order.items.map((item) => (
              <li key={item.id} className="flex justify-between gap-4 py-1.5">
                <span>{item.productName}</span>
                <span className="whitespace-nowrap text-muted-foreground">
                  {formatQuantity(item.quantity)} {item.unit ?? ""} × {formatPKR(item.priceCents / 100)}
                </span>
              </li>
            ))}
          </ul>
          {(order.poNumber || order.notes) && (
            <dl className="mt-2 grid gap-1 text-xs text-muted-foreground">
              {order.poNumber && <div><dt className="inline font-medium">PO: </dt><dd className="inline">{order.poNumber}</dd></div>}
              {order.notes && <div><dt className="inline font-medium">Notes: </dt><dd className="inline">{order.notes}</dd></div>}
            </dl>
          )}
        </div>
      )}
    </article>
  )
}

/**
 * The desk's own orders, by where they stand: waiting for an Apricart
 * Executive to approve, waiting for Super Admin to record delivery, ready for
 * the desk to fulfil, fulfilled, rejected, or cancelled. Each card offers only
 * the actions its stage allows; the server enforces them again.
 */
export function DeskOrdersTable({ initialTab = "awaiting_approval" }: Readonly<{ initialTab?: DeskOrderStatusFilter }>) {
  const [tab, setTab] = useState<DeskOrderStatusFilter>(initialTab)
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus | null>(null)
  const [organizationId, setOrganizationId] = useState(ALL)
  const [branchId, setBranchId] = useState(ALL)
  const [searchInput, setSearchInput] = useState("")
  // Search as the desk user types, without a request per keystroke.
  const search = useDebounce(searchInput.trim(), 300)
  const [page, setPage] = useState(1)
  const [fulfillingId, setFulfillingId] = useState<number | null>(null)
  const [dialog, setDialog] = useState<OpenDialog>(null)

  const { data: targetData } = useSWR<{ items: Target[] }>("/api/v1/order-desk/targets", fetcher)
  const targets = targetData?.items ?? []
  const branchOptions = targets.find((target) => String(target.id) === organizationId)?.branches ?? []

  const params = new URLSearchParams({ status: tab, page: String(page) })
  if (organizationId !== ALL) params.set("organizationId", organizationId)
  if (branchId !== ALL) params.set("branchId", branchId)
  if (tab === "fulfilled" && paymentStatus) params.set("paymentStatus", paymentStatus)
  if (search) params.set("q", search)
  const { data, error, isLoading, mutate } = useSWR<DeskOrderPage>(`${DESK_ORDERS_KEY_PREFIX}?${params.toString()}`, fetcher, {
    keepPreviousData: true,
  })

  const counts = data?.counts
  const orders = data?.items ?? []
  const pagination = data?.pagination

  const chooseTab = (next: DeskOrderStatusFilter) => {
    setTab(next)
    if (next !== "fulfilled") setPaymentStatus(null)
    setPage(1)
  }

  const fulfil = async (order: DeskOrder) => {
    if (fulfillingId !== null) return
    setFulfillingId(order.id)
    try {
      const response = await fetch(`/api/v1/order-desk/orders/${order.id}/fulfil`, { method: "POST" })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast({ title: "Not fulfilled", description: typeof result?.error === "string" ? result.error : "The order could not be fulfilled", variant: "destructive" })
        return
      }
      toast({ title: `${order.tid} fulfilled`, description: "It now appears under Fulfilled." })
      await mutate()
    } catch {
      toast({ title: "Not fulfilled", description: "Check the connection and try again.", variant: "destructive" })
    } finally {
      setFulfillingId(null)
    }
  }

  const closeAndRefresh = () => {
    setDialog(null)
    void mutate()
  }

  const readyCount = counts?.ready_to_fulfil ?? 0

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Order status" className="flex gap-2 overflow-x-auto pb-1">
        {DESK_ORDER_STATUS_FILTERS.map((filter) => {
          const selected = tab === filter
          const dot = filter === "all" ? null : STAGE_META[filter].dot
          return (
            <button
              key={filter}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => chooseTab(filter)}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                selected
                  ? "border-indigo-600 bg-indigo-600 text-white shadow-sm"
                  : "bg-background text-slate-700 hover:bg-muted dark:text-slate-200",
              )}
            >
              {dot && <span className={cn("h-2 w-2 rounded-full", dot, selected && "ring-2 ring-white/70")} aria-hidden="true" />}
              {TAB_LABELS[filter]}
              <span
                className={cn(
                  "rounded-full px-1.5 text-xs tabular-nums",
                  selected ? "bg-white/20 text-white" : "bg-muted text-muted-foreground",
                )}
              >
                {counts ? counts[filter] : "·"}
              </span>
            </button>
          )
        })}
      </div>

      {tab === "fulfilled" && (
        <div className="flex w-fit items-center rounded-xl border bg-muted/40 p-1" role="group" aria-label="Filter fulfilled orders by payment status">
          {([null, "PAID", "UNPAID"] as const).map((nextPaymentStatus) => (
            <Button
              key={nextPaymentStatus ?? "all"}
              type="button"
              size="sm"
              variant={paymentStatus === nextPaymentStatus ? "secondary" : "ghost"}
              aria-pressed={paymentStatus === nextPaymentStatus}
              onClick={() => { setPage(1); setPaymentStatus(nextPaymentStatus) }}
              className="h-8 rounded-lg px-3 text-xs font-bold"
            >
              {nextPaymentStatus ? PAYMENT_STATUS_LABELS[nextPaymentStatus] : "All payments"}
            </Button>
          ))}
        </div>
      )}

      {readyCount > 0 && tab !== "ready_to_fulfil" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-100">
          <span className="flex items-center gap-2">
            <PackageCheck className="h-4 w-4" aria-hidden="true" />
            {readyCount === 1 ? "1 order has been delivered and is ready for you to fulfil." : `${readyCount} orders have been delivered and are ready for you to fulfil.`}
          </span>
          <Button size="sm" variant="outline" className="border-indigo-300 bg-white dark:bg-transparent" onClick={() => chooseTab("ready_to_fulfil")}>
            Review <ArrowRight className="ml-1 h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_200px_200px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              aria-label="Search orders"
              placeholder="Search by order number or customer reference"
              value={searchInput}
              maxLength={100}
              onChange={(event) => { setSearchInput(event.target.value); setPage(1) }}
              className="pl-9"
            />
          </div>
          <Select value={organizationId} onValueChange={(value) => { setOrganizationId(value); setBranchId(ALL); setPage(1) }}>
            <SelectTrigger aria-label="Organization" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All organizations</SelectItem>
              {targets.map((target) => (
                <SelectItem key={target.id} value={String(target.id)}>{target.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={branchId} onValueChange={(value) => { setBranchId(value); setPage(1) }}>
            <SelectTrigger aria-label="Branch" className="w-full" disabled={organizationId === ALL}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All branches</SelectItem>
              {branchOptions.map((branch) => (
                <SelectItem key={branch.id} value={String(branch.id)}>{branch.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {tab !== "all" && <p className="text-sm text-muted-foreground">{STAGE_META[tab].hint}</p>}

      {error && <p role="alert" className="text-sm text-destructive">Could not load orders. Refresh the page to try again.</p>}
      {isLoading && !data && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading orders…
        </p>
      )}
      {data && orders.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
            <Inbox className="h-8 w-8" aria-hidden="true" />
            {search ? `No orders match “${search}”.` : EMPTY_MESSAGES[tab]}
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {orders.map((order) => (
          <OrderCard
            key={order.id}
            order={order}
            busy={fulfillingId === order.id}
            onAction={(next) => setDialog(next)}
          />
        ))}
      </div>

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages} · {pagination.total} orders
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        </div>
      )}

      <AlertDialog open={dialog?.kind === "fulfil"} onOpenChange={(open) => { if (!open) setDialog(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Fulfil {dialog?.order.tid}?</AlertDialogTitle>
            <AlertDialogDescription>
              Confirm the customer has received this order. It moves to Fulfilled; any later change goes through a refund request.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const order = dialog?.order
                setDialog(null)
                if (order) void fulfil(order)
              }}
            >
              Yes, fulfil
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {dialog?.kind === "edit" && (
        <EditDeskOrderDialog key={dialog.order.id} order={dialog.order} onClose={() => setDialog(null)} onSaved={closeAndRefresh} />
      )}
      {dialog?.kind === "cancel" && (
        <CancelDeskOrderDialog key={dialog.order.id} order={dialog.order} onClose={() => setDialog(null)} onSaved={closeAndRefresh} />
      )}
      {dialog?.kind === "resubmit" && (
        <ResubmitDeskOrderDialog key={dialog.order.id} order={dialog.order} onClose={() => setDialog(null)} onSaved={closeAndRefresh} />
      )}
      {dialog?.kind === "refund" && (
        <RefundDeskOrderDialog key={dialog.order.id} order={dialog.order} onClose={() => setDialog(null)} onSaved={closeAndRefresh} />
      )}
    </div>
  )
}
