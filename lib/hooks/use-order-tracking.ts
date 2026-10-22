"use client"
import useSWR from "swr"

import type { RecentTrackableOrder, TrackedOrderView } from "@/lib/order-tracking"

/** An error the page can show as is: the server's own message, never a raw exception. */
export class OrderTrackingError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { cache: "no-store" })
  } catch {
    throw new OrderTrackingError("We could not reach order tracking. Check your connection and try again.", 0)
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new OrderTrackingError(
      typeof payload?.error === "string" ? payload.error : "Order tracking is unavailable right now. Please try again.",
      response.status,
    )
  }
  return payload as T
}

/** One order's tracking view. A null reference makes no request. */
export function useTrackedOrder(reference: string | null) {
  const key = reference ? `/api/v1/order-tracking?reference=${encodeURIComponent(reference)}` : null
  return useSWR<{ item: TrackedOrderView }, OrderTrackingError>(key, fetchJson, {
    revalidateOnFocus: true,
    shouldRetryOnError: false,
    keepPreviousData: false,
  })
}

/** The caller's latest orders, for the picker. */
export function useRecentTrackableOrders() {
  return useSWR<{ items: RecentTrackableOrder[] }, OrderTrackingError>("/api/v1/order-tracking/recent", fetchJson, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}
