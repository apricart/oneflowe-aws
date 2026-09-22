"use client"
import useSWR from "swr"

import type { PaymentControlView } from "@/lib/payment-control-view"

export function paymentControlUrl(branchId?: number | null): string {
  return Number.isFinite(branchId) && (branchId as number) > 0
    ? `/api/v1/payment-control?branchId=${branchId}`
    : "/api/v1/payment-control"
}

async function fetchPaymentControl(url: string): Promise<PaymentControlView> {
  const response = await fetch(url, { cache: "no-store" })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error || "Unable to load payment status")
  return payload as PaymentControlView
}

/**
 * One branch's payment-control state. Without a branch id the server answers
 * for the session's own branch (the single-branch roles); the group and
 * tenant roles must name one. `enabled: false` skips the request entirely,
 * for a page that has no branch to ask about yet.
 */
export function usePaymentControl(branchId?: number | null, options: { enabled?: boolean } = {}) {
  const key = options.enabled === false ? null : paymentControlUrl(branchId)
  return useSWR<PaymentControlView, Error>(key, fetchPaymentControl, {
    revalidateOnFocus: true,
    keepPreviousData: true,
  })
}
