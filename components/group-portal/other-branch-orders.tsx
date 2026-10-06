"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { Building2, ChevronRight, Pencil, Send } from "lucide-react"

import { BranchOrderEditSheet } from "@/components/group-portal/branch-order-edit-sheet"
import { TokenHandoff } from "@/components/group-portal/token-handoff"
import { OrderDetailPanel, type OrderDetails } from "@/components/orders/order-detail-panel"
import { RefundManagement } from "@/components/refund-management"
import { OrderCorrectionNotice, ResubmitOrderDialog } from "@/components/orders/order-correction"
import { isAwaitingCorrection } from "@/lib/order-correction"
import { Button } from "@/components/ui/button"
import {
  OrderListBody,
  OrderListPager,
  OrderListSearch,
  OrderStatusPills,
  type OrderStatusPillOption,
} from "@/components/orders/order-list-chrome"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useDebounce } from "@/hooks/use-debounce"
import { fetcher } from "@/lib/fetcher"
import { FULFILLMENT_STATUS_LABELS, normalizeFulfillmentStatus } from "@/lib/fulfillment-status"
import { type OrderStatusFilter } from "@/lib/order-status"
import { formatQuantity } from "@/lib/quantity"
import { cn, formatPKR } from "@/lib/utils"

type BranchOrder = {
  id: number
  tid: string
  branchId: number
  branchName?: string | null
  branchCostCenterId?: string | null
  status: string
  fulfillmentStatus?: string | null
  totalCents?: number | null
  itemCount?: number | string | null
  itemNames?: string | null
  createdAt: string
  approvedAt?: string | null
  rejectionReason?: string | null
  returnedForCorrectionAt?: string | null
  correctionRequestNote?: string | null
  approvalToken?: string | null
  tokenHandoffAt?: string | null
}

type BranchOrdersResponse = {
  items?: BranchOrder[]
  pricesHidden?: boolean
  pagination?: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean }
}

type OrderDetailResponse = {
  item?: OrderDetails & Record<string, unknown>
}

const PAGE_SIZE = 25

const STATUS_TABS: ReadonlyArray<OrderStatusPillOption<OrderStatusFilter>> = [
  ["all", "All"],
  ["pending", "Pending"],
  ["approved", "Approved"],
  ["fulfilled", "Fulfilled"],
  ["rejected", "Rejected"],
]

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  APPROVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  FULFILLED: "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300",
  REJECTED: "bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
  CANCELLED: "bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
  REFUNDED: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
}

function statusStyle(status: string): string {
  return STATUS_STYLES[status.toUpperCase()] ?? STATUS_STYLES.REFUNDED
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—"
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

/**
 * What the branches assigned to this requester have ordered for themselves.
 *
 * "My group orders" answers "what did I raise"; this answers "what did the
 * people at those branches raise", which is the context a requester needs
 * before spending more of the same branch budget.
 *
 * The requester may act only inside its live branch assignments. Approved rows
 * include the fulfillment-token handoff because every operational role may
 * complete an order it is already allowed to read; the endpoint independently
 * re-checks the tenant and assignment before sending. Other controls keep their
 * own policies, including invoice access.
 *
 * The rows come from the standard `/api/v1/orders` endpoint, which resolves this
 * user's branch assignments server-side; the `createdByRole` filter narrows that
 * set to the employees' own orders and can never widen it.
 */
export function OtherBranchOrders() {
  const [status, setStatus] = useState<OrderStatusFilter>("all")
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const [openOrder, setOpenOrder] = useState<BranchOrder | null>(null)
  const debouncedSearch = useDebounce(search.trim(), 300)

  const endpoint = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(PAGE_SIZE),
      createdByRole: "ORDER_PORTAL",
    })
    if (status !== "all") params.set("status", status)
    if (debouncedSearch) params.set("q", debouncedSearch)
    return `/api/v1/orders?${params.toString()}`
  }, [debouncedSearch, page, status])

  // A different filter or search describes a different set of orders, so the
  // page the user was on would strand them on an empty one.
  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, status])

  const { data, error, isLoading, isValidating, mutate } = useSWR<BranchOrdersResponse>(
    endpoint,
    fetcher,
    { keepPreviousData: true },
  )

  const [editOrder, setEditOrder] = useState<BranchOrder | null>(null)
  const [resubmitOrder, setResubmitOrder] = useState<BranchOrder | null>(null)

  const orders = data?.items ?? []
  const total = Number(data?.pagination?.total ?? 0)
  const totalPages = Math.max(1, Number(data?.pagination?.totalPages ?? 1))
  const pricesHidden = Boolean(data?.pricesHidden)

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <OrderStatusPills value={status} options={STATUS_TABS} onChange={setStatus} />
        <OrderListSearch
          value={search}
          onChange={setSearch}
          onRefresh={() => { void mutate() }}
          refreshing={isValidating}
          label="Search branch orders"
        />
      </div>

      <OrderListBody
        loading={isLoading && !data}
        error={Boolean(error)}
        isEmpty={orders.length === 0}
        emptyMessage="No orders raised by your branches' own people match this filter."
      >
        <div className="space-y-3">
          {orders.map((order) => (
            <OrderRow
              key={order.id}
              order={order}
              pricesHidden={pricesHidden}
              onOpen={() => setOpenOrder(order)}
            />
          ))}
        </div>
      </OrderListBody>

      <OrderListPager
        page={page}
        totalPages={totalPages}
        total={total}
        busy={isLoading}
        onChange={setPage}
      />

      <OrderDetailSheet
        order={openOrder}
        onClose={() => setOpenOrder(null)}
        onEdit={(target) => { setOpenOrder(null); setEditOrder(target) }}
        onResubmit={(target) => { setOpenOrder(null); setResubmitOrder(target) }}
        onChanged={() => { void mutate() }}
      />

      <ResubmitOrderDialog
        order={resubmitOrder}
        onClose={() => setResubmitOrder(null)}
        onResubmitted={() => { void mutate() }}
      />

      <BranchOrderEditSheet
        order={editOrder}
        onClose={() => setEditOrder(null)}
        onSaved={() => { void mutate() }}
      />
    </div>
  )
}

function OrderRow({
  order,
  pricesHidden,
  onOpen,
}: Readonly<{ order: BranchOrder; pricesHidden: boolean; onOpen: () => void }>) {
  const itemCount = Number(order.itemCount ?? 0)
  const progress = normalizeFulfillmentStatus(order.fulfillmentStatus)

  return (
    <Card className="overflow-hidden rounded-2xl border-slate-200 transition hover:border-indigo-200 dark:border-slate-800 dark:hover:border-indigo-800">
      <CardContent className="p-0">
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full items-center gap-4 p-4 text-left"
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-bold text-slate-900 dark:text-slate-100">
                {order.tid}
              </span>
              <Badge className={cn("rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider", statusStyle(order.status))}>
                {isAwaitingCorrection(order) ? "Returned" : order.status}
              </Badge>
              {order.status.toUpperCase() === "APPROVED" && (
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  {FULFILLMENT_STATUS_LABELS[progress]}
                </span>
              )}
            </div>

            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1">
                <Building2 className="h-3 w-3" />
                {order.branchName || `Branch ${order.branchId}`}
              </span>
              <span>{formatDate(order.createdAt)}</span>
              <span>
                {formatQuantity(itemCount)} item{itemCount === 1 ? "" : "s"}
              </span>
              {!pricesHidden && typeof order.totalCents === "number" && (
                <span className="font-bold text-slate-700 dark:text-slate-200">
                  {formatPKR(order.totalCents / 100)}
                </span>
              )}
            </p>
          </div>

          <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 dark:text-slate-600" />
        </button>
      </CardContent>
    </Card>
  )
}

/**
 * The order as raised inside this requester's assigned branch scope.
 *
 * It renders the shared `OrderDetailPanel` — the same body the Branch Admin,
 * the Order Portal and this portal's own approvals drawer show — so an order
 * looks the same to a requester here as it does to the people it is raised
 * with. The panel owns no decision logic; the `actions` footer supplies only
 * actions independently authorized for this requester and order.
 *
 * Fetched fresh rather than shown from the list row, so the line items and the
 * status are the current ones; the row paints the panel immediately while that
 * request is in flight. An approved order whose scoped response carries a token
 * can be handed to admin operations from this drawer.
 */
function OrderDetailSheet({
  order,
  onClose,
  onEdit,
  onResubmit,
  onChanged,
}: Readonly<{
  order: BranchOrder | null
  onClose: () => void
  onEdit: (order: BranchOrder) => void
  onResubmit: (order: BranchOrder) => void
  onChanged: () => void
}>) {
  const [expanded, setExpanded] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const { data, error, isLoading } = useSWR<OrderDetailResponse>(
    order ? [`/api/v1/orders/${order.id}`, reloadKey] : null,
    ([url]: [string, number]) => fetcher(url),
  )

  const fetched = data?.item
  const matched = fetched && fetched.id === order?.id ? fetched : null
  // The detail endpoint carries the refund state; the list row does not, so it
  // is read from the fetched record rather than from the row that opened this.
  const refundState = (matched ?? {}) as {
    refundAmountCents?: number | null
    refundedAt?: string | null
    refundReason?: string | null
    pricesHidden?: boolean
  }
  // The list row paints immediately; the fetched record only adds detail.
  const detailedOrder = { ...order, ...matched }
  const token = typeof detailedOrder.approvalToken === "string"
    && detailedOrder.approvalToken.trim().length > 0
    ? detailedOrder.approvalToken
    : null

  const closeSheet = () => {
    setExpanded(false)
    onClose()
  }

  return (
    <Sheet open={Boolean(order)} onOpenChange={(open) => { if (!open) closeSheet() }}>
      <SheetContent className="w-full overflow-y-auto border-l-0 bg-[#fdfdfd] p-0 shadow-[0_0_50px_rgba(0,0,0,0.1)] dark:bg-[#0b0f19] sm:max-w-md">
        <SheetHeader className="sr-only p-0">
          <SheetTitle>Order details</SheetTitle>
          <SheetDescription>
            {order
              ? `Order ${order.tid}, raised at ${order.branchName || `branch ${order.branchId}`}. Actions remain limited to your assigned branch scope.`
              : "Review the order status, branch information, and line items."}
          </SheetDescription>
        </SheetHeader>

        {order && (
          <OrderDetailPanel
            order={detailedOrder}
            details={matched}
            detailsExpanded={expanded}
            detailsLoading={isLoading}
            detailsError={error ? (error as Error)?.message || "Unable to load order details" : null}
            onToggleDetails={() => setExpanded((open) => !open)}
            onRetryDetails={() => setReloadKey((key) => key + 1)}
            actions={
              <div className="mt-auto shrink-0 space-y-4 border-t border-slate-100 bg-white/80 px-6 py-4 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-900/80">
                {String(detailedOrder.status).toUpperCase() === "APPROVED" && token && (
                  <TokenHandoff
                    orderId={order.id}
                    tid={order.tid}
                    token={token}
                    branchName={order.branchName ?? undefined}
                    onFulfilled={() => {
                      onChanged()
                      closeSheet()
                    }}
                  />
                )}
                {/* The branch owns its orders, so a group requester may amend a
                    still-pending one. The server re-checks the same rule and
                    tells the person who raised it. */}
                {isAwaitingCorrection(detailedOrder) && (
                  <OrderCorrectionNotice
                    comment={detailedOrder.correctionRequestNote}
                    returnedAt={detailedOrder.returnedForCorrectionAt}
                    audience="requester"
                  />
                )}
                {String(detailedOrder.status).toUpperCase() === "PENDING" && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() => onEdit(order)}
                  >
                    <Pencil className="h-4 w-4" />
                    Edit order
                  </Button>
                )}
                {isAwaitingCorrection(detailedOrder) && (
                  <Button
                    type="button"
                    className="w-full gap-2"
                    onClick={() => onResubmit({ ...order, correctionRequestNote: detailedOrder.correctionRequestNote ?? null })}
                  >
                    <Send className="h-4 w-4" />
                    Resubmit for approval
                  </Button>
                )}
                <RefundManagement
                  orderId={order.id}
                  orderTotalCents={detailedOrder.totalCents ?? null}
                  orderStatus={String(detailedOrder.status ?? "")}
                  orderFulfillmentStatus={detailedOrder.fulfillmentStatus ?? null}
                  createdAt={String(detailedOrder.createdAt ?? "")}
                  requesterRole="GROUP_ORDER_PORTAL"
                  allowRefundRequest
                  pricesHidden={Boolean(refundState.pricesHidden)}
                  initialOrderItems={matched?.orderItems ?? []}
                  refundAmountCents={refundState.refundAmountCents ?? null}
                  refundedAt={refundState.refundedAt ?? null}
                  refundReason={refundState.refundReason ?? null}
                  onRefundSuccess={onChanged}
                />
              </div>
            }
          />
        )}
      </SheetContent>
    </Sheet>
  )
}
