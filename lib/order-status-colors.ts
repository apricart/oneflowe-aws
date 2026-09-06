import { normalizeFulfillmentStatus } from "@/lib/fulfillment-status"
import { normalizePaymentStatus } from "@/lib/payment-status"

/**
 * Badge classes for the delivery and payment badges. They live here rather than
 * beside one of the components that render them so every surface — the orders
 * table, the order detail panel and the order report — colours the same status
 * the same way.
 */
export function getFulfillmentProgressColor(status?: string | null) {
  switch (normalizeFulfillmentStatus(status)) {
    case "DELIVERED":
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
    case "OUT_FOR_DELIVERY":
      return "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-300"
    case "IN_PROCESS":
      return "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-300"
    default:
      return "border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400"
  }
}

export function getPaymentStatusColor(status?: string | null) {
  return normalizePaymentStatus(status) === "PAID"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
    : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
}
