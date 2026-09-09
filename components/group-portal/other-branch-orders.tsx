"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { Building2, ChevronRight, User } from "lucide-react"

import {
  OrderListBody,
  OrderListPager,
  OrderListSearch,
  OrderStatusPills,
  type OrderStatusPillOption,
} from "@/components/orders/order-list-chrome"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { ListSkeleton } from "@/components/ui/skeleton"
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
}

type BranchOrdersResponse = {
  items?: BranchOrder[]
  pricesHidden?: boolean
  pagination?: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean }
}

type OrderDetailLine = {
  id: number
  productName: string
  productCode?: string | null
  quantity: number | string
  priceCents?: number | null
  unit?: string | null
}

type OrderDetailResponse = {
  item?: BranchOrder & {
    creatorName?: string | null
    subtotalCents?: number | null
    taxCents?: number | null
    notes?: string | null
    poNumber?: string | null
    deliveredAt?: string | null
    orderItems?: OrderDetailLine[]
    pricesHidden?: boolean
  }
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
 * It is **read-only, by design and not merely by omission**. Editing, refunding,
 * the fulfilment token, the token email and the invoice all stay with the person
 * who raised the order — four separate server-side controls enforce that, and
 * a receipt or an invoice for someone else's order is refused by
 * `authorizeInvoiceRequest`. Rather than render those controls and let the
 * server turn them down, the surface simply does not offer them.
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
        pricesHidden={pricesHidden}
        onClose={() => setOpenOrder(null)}
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
                {order.status}
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
                  {formatPKR(order.totalCents)}
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
 * The order as raised, read-only. Fetched fresh rather than shown from the list
 * row, so the line items and the status are the current ones.
 */
function OrderDetailSheet({
  order,
  pricesHidden,
  onClose,
}: Readonly<{ order: BranchOrder | null; pricesHidden: boolean; onClose: () => void }>) {
  const { data, error, isLoading } = useSWR<OrderDetailResponse>(
    order ? `/api/v1/orders/${order.id}` : null,
    fetcher,
  )

  const detail = data?.item
  const lines = detail?.orderItems ?? []
  const hidePrices = pricesHidden || Boolean(detail?.pricesHidden)

  return (
    <Sheet open={Boolean(order)} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="font-mono text-base">{order?.tid}</SheetTitle>
          <SheetDescription>
            Raised at {order?.branchName || `Branch ${order?.branchId}`}. You are viewing this
            order; it stays with the person who placed it.
          </SheetDescription>
        </SheetHeader>

        <DetailBody error={Boolean(error)} loading={isLoading && !data}>
          <div className="mt-5 space-y-5">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <DetailField label="Status" value={detail?.status ?? order?.status ?? "—"} />
              <DetailField
                label="Progress"
                value={FULFILLMENT_STATUS_LABELS[normalizeFulfillmentStatus(detail?.fulfillmentStatus)]}
              />
              <DetailField label="Raised by" value={detail?.creatorName || "—"} icon={<User className="h-3 w-3" />} />
              <DetailField label="Placed" value={formatDate(detail?.createdAt ?? order?.createdAt)} />
              <DetailField label="Approved" value={formatDate(detail?.approvedAt)} />
              <DetailField label="Delivered" value={formatDate(detail?.deliveredAt)} />
              {detail?.poNumber && <DetailField label="PO number" value={detail.poNumber} />}
            </dl>

            {detail?.rejectionReason && (
              <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3 text-sm text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-300">
                <p className="text-[10px] font-bold uppercase tracking-wider">Rejection reason</p>
                <p className="mt-1">{detail.rejectionReason}</p>
              </div>
            )}

            <section>
              <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Items
              </h3>
              <ul className="space-y-2">
                {lines.map((line) => (
                  <li
                    key={line.id}
                    className="flex items-start justify-between gap-3 rounded-xl border border-slate-100 p-3 text-sm dark:border-slate-800"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900 dark:text-slate-100">{line.productName}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {formatQuantity(Number(line.quantity))} {line.unit || ""}
                      </p>
                    </div>
                    {!hidePrices && typeof line.priceCents === "number" && (
                      <span className="shrink-0 text-xs font-bold text-slate-700 dark:text-slate-200">
                        {formatPKR(line.priceCents * Number(line.quantity))}
                      </span>
                    )}
                  </li>
                ))}
                {lines.length === 0 && (
                  <li className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400 dark:border-slate-800">
                    No line items recorded.
                  </li>
                )}
              </ul>
            </section>

            {!hidePrices && typeof detail?.totalCents === "number" && (
              <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-sm font-bold dark:border-slate-800">
                <span className="text-slate-500">Order total</span>
                <span className="text-slate-900 dark:text-white">{formatPKR(detail.totalCents)}</span>
              </div>
            )}
          </div>
        </DetailBody>
      </SheetContent>
    </Sheet>
  )
}

function DetailBody({
  loading,
  error,
  children,
}: Readonly<{ loading: boolean; error: boolean; children: React.ReactNode }>) {
  if (loading) return <div className="mt-6"><ListSkeleton rows={4} /></div>

  if (error) {
    return (
      <p role="alert" className="mt-6 text-sm text-slate-700 dark:text-slate-300">
        This order could not be loaded. Please try again.
      </p>
    )
  }

  return <>{children}</>
}

function DetailField({
  label,
  value,
  icon,
}: Readonly<{ label: string; value: string; icon?: React.ReactNode }>) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
        {icon}
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-slate-900 dark:text-slate-100" title={value}>
        {value}
      </dd>
    </div>
  )
}
