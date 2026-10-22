"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"

import {
  OrderListBody,
  OrderListPager,
  OrderListSearch,
  OrderStatusPills,
  type OrderStatusPillOption,
} from "@/components/orders/order-list-chrome"
import { OrdersDirectory } from "@/components/orders/orders-directory"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useDebounce } from "@/hooks/use-debounce"
import { fetcher } from "@/lib/fetcher"
import { selectOrdersForListView } from "@/lib/order-list-view"
import { type OrderStatusFilter } from "@/lib/order-status"
import { PAYMENT_STATUS_LABELS, type PaymentStatus } from "@/lib/payment-status"

type OtherOrdersResponse = {
  items?: any[]
  pricesHidden?: boolean
  capabilities?: { canApproveOrders?: boolean; canRejectOrders?: boolean }
  pagination?: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean }
}

const PAGE_SIZE = 25

const STATUS_TABS: ReadonlyArray<OrderStatusPillOption<OrderStatusFilter>> = [
  ["pending", "Pending"],
  ["approved", "Approved"],
  ["fulfilled", "Fulfilled"],
  ["rejected", "Rejected"],
  ["refunded", "Refunded"],
  ["all", "All"],
]

/**
 * The orders branch employees raised themselves, across this approver's
 * branches.
 *
 * The group queue answers "what did a Group Order Portal submission send to my
 * branches"; this answers "what have my branches' own people asked for". The
 * two are decided for different reasons, so they are read separately rather
 * than sorted out of one list by a badge.
 *
 * It reads the standard, already role-scoped orders endpoint with a
 * `createdByRole` filter, so the branch set still comes from this user's own
 * assignments resolved server-side — the filter can only remove rows from that
 * set, never add one. Rows are rendered through the same `OrdersDirectory` the
 * `/orders` screen uses, which is what gives this tab the Branch Admin's action
 * set without a second implementation of it: approve, reject, the fulfilment
 * token and its email, the order detail, receipts and invoices. Fulfilment and
 * payment status stay closed here because their endpoints are Super Admin only
 * for every role, the Branch Admin included.
 */
export function ApprovalOtherOrders() {
  const [status, setStatus] = useState<OrderStatusFilter>("pending")
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus | null>(null)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const debouncedSearch = useDebounce(search.trim(), 300)

  const endpoint = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(PAGE_SIZE),
      createdByRole: "ORDER_PORTAL",
    })
    if (status !== "all") params.set("status", status)
    if (status === "fulfilled" && paymentStatus) params.set("paymentStatus", paymentStatus)
    if (debouncedSearch) params.set("q", debouncedSearch)
    return `/api/v1/orders?${params.toString()}`
  }, [debouncedSearch, page, paymentStatus, status])

  // A filter or a search describes a different set of orders, so the page the
  // user was on no longer means anything and would strand them on an empty one.
  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, paymentStatus, status])

  useEffect(() => {
    if (status !== "fulfilled" && paymentStatus !== null) setPaymentStatus(null)
  }, [paymentStatus, status])

  const { data, error, isLoading, isValidating, mutate } = useSWR<OtherOrdersResponse>(
    endpoint,
    fetcher,
    { keepPreviousData: true },
  )

  // The server answers the status tabs; "fulfilled" and "refunded" carry a
  // partial/full split it has no parameter for, so the shared selector applies
  // it here exactly as the orders screen does.
  const orders = useMemo(
    () => selectOrdersForListView<any>(data?.items ?? [], { statusFilter: status, splitFilter: "all" }),
    [data, status],
  )

  const total = Number(data?.pagination?.total ?? 0)
  const totalPages = Math.max(1, Number(data?.pagination?.totalPages ?? 1))

  // The endpoint re-resolves this user's branch assignments to decide this, so
  // hiding the controls when it says no keeps the screen honest. It is not what
  // stops the decision — the endpoint is.
  const canDecideOrders = Boolean(
    data?.capabilities?.canApproveOrders && data?.capabilities?.canRejectOrders,
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <OrderStatusPills
            value={status}
            options={STATUS_TABS}
            onChange={(nextStatus) => {
              setStatus(nextStatus)
              if (nextStatus !== "fulfilled") setPaymentStatus(null)
            }}
          />
          {status === "fulfilled" && (
            <div className="flex items-center rounded-xl border border-slate-200/60 bg-slate-100/60 p-1 dark:border-slate-700/50 dark:bg-slate-800/50" role="group" aria-label="Filter fulfilled orders by payment status">
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
        </div>
        <OrderListSearch
          value={search}
          onChange={setSearch}
          onRefresh={() => { void mutate() }}
          refreshing={isValidating}
          label="Search employee orders"
        />
      </div>

      <Card className="overflow-hidden rounded-2xl border-slate-200 dark:border-slate-800">
        <CardContent className="p-0">
          <OrderListBody
            loading={isLoading && !data}
            error={Boolean(error)}
            isEmpty={orders.length === 0}
            emptyMessage="No orders raised by your branches' own people match this filter."
          >
            <OrdersDirectory
              orders={orders}
              statusContext={status === "fulfilled" || status === "refunded" ? status : "default"}
              userRole="GROUP_USER"
              isSuperAdmin={false}
              isBranchAdmin={false}
              isHeadOffice={false}
              canDecideOrders={canDecideOrders}
              pricesHidden={Boolean(data?.pricesHidden)}
              onUpdate={() => { void mutate() }}
            />
          </OrderListBody>
        </CardContent>
      </Card>

      <OrderListPager
        page={page}
        totalPages={totalPages}
        total={total}
        busy={isLoading}
        onChange={setPage}
      />
    </div>
  )
}
