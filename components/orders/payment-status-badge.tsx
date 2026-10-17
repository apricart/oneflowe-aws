import { Badge } from "@/components/ui/badge"
import { getPaymentStatusColor } from "@/lib/order-status-colors"
import { shouldShowOrderPaymentStatus, type OrderStatusDisplaySource } from "@/lib/order-status-display"
import { PAYMENT_STATUS_LABELS, normalizePaymentStatus } from "@/lib/payment-status"
import { cn } from "@/lib/utils"

/**
 * The order's Paid / Unpaid badge, shown wherever the orders table shows it
 * (lib/order-status-display.ts) and coloured the same way. A rejected or
 * cancelled order has nothing to pay, so it renders `fallback` instead.
 */
export function PaymentStatusBadge({
  order,
  className,
  fallback = null,
}: Readonly<{
  order: Pick<OrderStatusDisplaySource, "status" | "paymentStatus">
  className?: string
  fallback?: React.ReactNode
}>) {
  if (!shouldShowOrderPaymentStatus(order)) return <>{fallback}</>
  return (
    <Badge
      variant="outline"
      className={cn(
        "whitespace-nowrap rounded-lg border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider",
        getPaymentStatusColor(order.paymentStatus),
        className,
      )}
    >
      {PAYMENT_STATUS_LABELS[normalizePaymentStatus(order.paymentStatus)]}
    </Badge>
  )
}
