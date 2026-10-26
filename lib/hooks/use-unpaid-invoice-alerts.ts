"use client"
import useSWR from "swr"

import { parseUnpaidInvoiceAlertsView, type UnpaidInvoiceAlertsView } from "@/lib/unpaid-invoice-alerts"

export const UNPAID_INVOICE_ALERTS_URL = "/api/v1/payment-control/ordering-alerts"

async function fetchUnpaidInvoiceAlerts(url: string): Promise<UnpaidInvoiceAlertsView> {
  const response = await fetch(url, { cache: "no-store" })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error || "Unable to load ordering alerts")
  return parseUnpaidInvoiceAlertsView(payload)
}

/**
 * The caller's branches blocked by unpaid invoices, or one short of it.
 * `enabled: false` skips the request, for a role that is never alerted.
 */
export function useUnpaidInvoiceAlerts(options: { enabled?: boolean } = {}) {
  return useSWR<UnpaidInvoiceAlertsView, Error>(
    options.enabled === false ? null : UNPAID_INVOICE_ALERTS_URL,
    fetchUnpaidInvoiceAlerts,
    { revalidateOnFocus: true, keepPreviousData: true },
  )
}
