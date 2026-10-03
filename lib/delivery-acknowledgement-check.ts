import {
  noticeFromDeliveryAcknowledgementView,
  type UnacknowledgedDeliveriesNotice,
} from "@/lib/unacknowledged-delivery-block"

export function deliveryAcknowledgementUrl(branchId?: number | null): string {
  return Number.isSafeInteger(branchId) && (branchId as number) > 0
    ? `/api/v1/orders/delivery-acknowledgement?branchId=${branchId}`
    : "/api/v1/orders/delivery-acknowledgement"
}

/**
 * Ask, just before an order is attempted, whether the branch is blocked for
 * delivered orders awaiting acknowledgement, so the popup can appear before
 * anything is submitted.
 *
 * Presentation only, and it fails open: a failed or malformed check returns
 * null and the order goes to the server, whose gate refuses it with a 409 the
 * page turns into the same popup. A UI check is never the control.
 *
 * Without a branch id the server answers for the session's own branch (the
 * single-branch roles); the tenant roles name the branch they order for.
 */
export async function checkDeliveryAcknowledgementBlock(
  branchId: number | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<UnacknowledgedDeliveriesNotice | null> {
  try {
    const response = await fetchImpl(deliveryAcknowledgementUrl(branchId), { cache: "no-store" })
    if (!response.ok) return null
    const view = await response.json().catch(() => null)
    return noticeFromDeliveryAcknowledgementView(view)
  } catch {
    return null
  }
}
