"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { Building2, ChevronRight } from "lucide-react"

import { BranchOrderDetailSheet, type BranchOrder } from "@/components/group-portal/branch-order-detail-sheet"
import { BranchOrderEditSheet } from "@/components/group-portal/branch-order-edit-sheet"
import { ResubmitOrderDialog } from "@/components/orders/order-correction"
import { isAwaitingCorrection } from "@/lib/order-correction"
import {
  OrderListBody,
  OrderListPager,
  OrderListSearch,
  OrderStatusPills,
  type OrderStatusPillOption,
} from "@/components/orders/order-list-chrome"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { useDebounce } from "@/hooks/use-debounce"
import { fetcher } from "@/lib/fetcher"
import { FULFILLMENT_STATUS_LABELS, normalizeFulfillmentStatus } from "@/lib/fulfillment-status"
import { type OrderStatusFilter } from "@/lib/order-status"
import { formatQuantity } from "@/lib/quantity"
import { cn, formatPKR } from "@/lib/utils"

type BranchOrdersResponse = {
  items?: BranchOrder[]
  pricesHidden?: boolean
  pagination?: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean }
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

      <BranchOrderDetailSheet
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
