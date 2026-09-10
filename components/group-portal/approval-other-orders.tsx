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
import { useDebounce } from "@/hooks/use-debounce"
import { fetcher } from "@/lib/fetcher"
import { selectOrdersForListView } from "@/lib/order-list-view"
import { type OrderStatusFilter } from "@/lib/order-status"

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
    if (debouncedSearch) params.set("q", debouncedSearch)
    return `/api/v1/orders?${params.toString()}`
  }, [debouncedSearch, page, status])

  // A filter or a search describes a different set of orders, so the page the
  // user was on no longer means anything and would strand them on an empty one.
  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, status])

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
        <OrderStatusPills value={status} options={STATUS_TABS} onChange={setStatus} />
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
