/**
 * Colours for a delivery's health, shared by the warehouse queue and its order
 * panel. Presentation only; health itself is decided on the server by
 * `assessDelivery` (`lib/delivery-sla.ts`).
 */
export const DELIVERY_HEALTH_STYLES: Record<string, string> = {
  OVERDUE: "bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
  DUE_SOON: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  ON_TRACK: "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300",
  DELIVERED_ON_TIME: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  DELIVERED_LATE: "bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-300",
  DELIVERED_UNTIMED: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
}

export const NEUTRAL_HEALTH_STYLE = "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"

export const PAYMENT_STATUS_STYLES: Record<string, string> = {
  PAID: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  UNPAID: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
}

export function healthStyle(health: string | null | undefined): string {
  return (health && DELIVERY_HEALTH_STYLES[health]) || NEUTRAL_HEALTH_STYLE
}

export function paymentStyle(status: string | null | undefined): string {
  return (status && PAYMENT_STATUS_STYLES[status]) || NEUTRAL_HEALTH_STYLE
}
