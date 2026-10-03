import { paymentControlUrl } from "@/lib/hooks/use-payment-control"
import { orderingBlockFromStatusView, type OrderingBlock } from "@/lib/unpaid-invoice-block"

/**
 * Ask, just before an order is attempted, whether the branch is blocked for
 * unpaid invoices, so the popup can appear before anything is submitted.
 *
 * Presentation only, and it fails open: a failed or malformed check returns
 * null and the order goes to the server, whose gate refuses it with a 409 the
 * page turns into the same popup. A UI check is never the control.
 *
 * Without a branch id the server answers for the session's own branch (the
 * single-branch roles); the tenant roles name the branch they order for.
 */
export async function checkOrderingBlock(
  branchId: number | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<OrderingBlock | null> {
  try {
    const response = await fetchImpl(paymentControlUrl(branchId), { cache: "no-store" })
    if (!response.ok) return null
    const view = await response.json().catch(() => null)
    return orderingBlockFromStatusView(view)
  } catch {
    return null
  }
}
