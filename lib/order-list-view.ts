import {
  getOrderFulfillmentVariant,
  getOrderRefundVariant,
  type OrderSplitFilter,
  type OrderStatusFilter,
} from "@/lib/order-status"

export type OrderListViewSource = {
  status?: string | null
  refundAmountCents?: number | null
  createdAt: string | Date
}

export type OrderListViewOptions = {
  statusFilter: OrderStatusFilter
  splitFilter: OrderSplitFilter
}

/**
 * The rows the orders screen shows for a given pair of filters, in the order it
 * shows them.
 *
 * The status tabs are answered by the server, but two of them are narrowed
 * again here: "fulfilled" and "refunded" carry a partial/full split the API has
 * no parameter for. Export runs over every page rather than the one on screen,
 * so the narrowing has to be applied from one place — a second copy inside the
 * export would silently hand out rows the screen had filtered away.
 */
export function selectOrdersForListView<T extends OrderListViewSource>(
  orders: readonly T[],
  { statusFilter, splitFilter }: OrderListViewOptions,
): T[] {
  let filtered = [...orders]

  if (statusFilter !== "all") {
    if (statusFilter === "refunded") {
      filtered = filtered.filter((order) => String(order.status || "").toLowerCase() === "refunded")
    } else if (statusFilter === "fulfilled") {
      filtered = filtered.filter((order) => getOrderFulfillmentVariant(order) !== "none")
    } else if (statusFilter === "rejected") {
      filtered = filtered.filter((order) => {
        const status = String(order.status || "").toLowerCase()
        return status === "rejected" || status === "cancelled"
      })
    } else {
      filtered = filtered.filter((order) => String(order.status || "").toLowerCase() === statusFilter)
    }
  }

  const showsSplit = statusFilter === "fulfilled" || statusFilter === "refunded"
  if (showsSplit && splitFilter !== "all") {
    filtered = filtered.filter((order) => {
      const variant = statusFilter === "refunded"
        ? getOrderRefundVariant(order)
        : getOrderFulfillmentVariant(order)
      return variant === splitFilter
    })
  }

  return filtered.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
}
