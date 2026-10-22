"use client"

import Link from "next/link"
import { useState } from "react"
import useSWR from "swr"
import { Ban, Pencil, Route, Send } from "lucide-react"

import { TokenHandoff } from "@/components/group-portal/token-handoff"
import { OrderDetailPanel, type OrderDetails } from "@/components/orders/order-detail-panel"
import { RefundManagement } from "@/components/refund-management"
import { OrderCorrectionNotice } from "@/components/orders/order-correction"
import { isCancellableGroupOrderStatus } from "@/lib/group-order-cancel"
import { isAwaitingCorrection } from "@/lib/order-correction"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { fetcher } from "@/lib/fetcher"

/** One branch order, as much of it as a list row knows before the detail loads. */
export type BranchOrder = {
  id: number
  tid: string
  branchId: number
  branchName?: string | null
  branchCostCenterId?: string | null
  status: string
  fulfillmentStatus?: string | null
  paymentStatus?: string | null
  totalCents?: number | null
  itemCount?: number | string | null
  itemNames?: string | null
  createdAt: string | null
  approvedAt?: string | null
  fulfilledAt?: string | null
  rejectionReason?: string | null
  returnedForCorrectionAt?: string | null
  correctionRequestNote?: string | null
  approvalToken?: string | null
  tokenHandoffAt?: string | null
}

type OrderDetailResponse = {
  item?: OrderDetails & Record<string, unknown>
}

/**
 * A branch order inside this requester's assigned branch scope, in a side
 * sheet. "Other orders" and "My group orders" both open it, so an order looks
 * and acts the same whichever tab it was found in.
 *
 * It renders the shared `OrderDetailPanel` — the same body the Branch Admin,
 * the Order Portal and this portal's own approvals drawer show — so an order
 * looks the same to a requester here as it does to the people it is raised
 * with. The panel owns no decision logic; the `actions` footer supplies only
 * actions independently authorized for this requester and order.
 *
 * Fetched fresh rather than shown from the list row, so the line items and the
 * status are the current ones; the row paints the panel immediately while that
 * request is in flight. An approved order whose scoped response carries a token
 * can be handed to admin operations from this drawer.
 *
 * `onCancel` is passed only where the order is known to be a group order the
 * requester may withdraw ("My group orders"); the button shows only while the
 * order is still pending. The server re-checks both.
 */
export function BranchOrderDetailSheet({
  order,
  onClose,
  onEdit,
  onResubmit,
  onChanged,
  onCancel,
}: Readonly<{
  order: BranchOrder | null
  onClose: () => void
  onEdit: (order: BranchOrder) => void
  onResubmit: (order: BranchOrder) => void
  onChanged: () => void
  onCancel?: (order: BranchOrder) => void
}>) {
  const [expanded, setExpanded] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const { data, error, isLoading } = useSWR<OrderDetailResponse>(
    order ? [`/api/v1/orders/${order.id}`, reloadKey] : null,
    ([url]: [string, number]) => fetcher(url),
  )

  const fetched = data?.item
  const matched = fetched && fetched.id === order?.id ? fetched : null
  // The detail endpoint carries the refund state; the list row does not, so it
  // is read from the fetched record rather than from the row that opened this.
  const refundState = (matched ?? {}) as {
    refundAmountCents?: number | null
    refundedAt?: string | null
    refundReason?: string | null
    pricesHidden?: boolean
  }
  // The list row paints immediately; the fetched record only adds detail.
  const detailedOrder = { ...order, ...matched }
  const token = typeof detailedOrder.approvalToken === "string"
    && detailedOrder.approvalToken.trim().length > 0
    ? detailedOrder.approvalToken
    : null

  const closeSheet = () => {
    setExpanded(false)
    onClose()
  }

  return (
    <Sheet open={Boolean(order)} onOpenChange={(open) => { if (!open) closeSheet() }}>
      <SheetContent className="w-full overflow-y-auto border-l-0 bg-[#fdfdfd] p-0 shadow-[0_0_50px_rgba(0,0,0,0.1)] dark:bg-[#0b0f19] sm:max-w-md">
        <SheetHeader className="sr-only p-0">
          <SheetTitle>Order details</SheetTitle>
          <SheetDescription>
            {order
              ? `Order ${order.tid}, raised at ${order.branchName || `branch ${order.branchId}`}. Actions remain limited to your assigned branch scope.`
              : "Review the order status, branch information, and line items."}
          </SheetDescription>
        </SheetHeader>

        {order && (
          <OrderDetailPanel
            order={detailedOrder}
            details={matched}
            detailsExpanded={expanded}
            detailsLoading={isLoading}
            detailsError={error ? (error as Error)?.message || "Unable to load order details" : null}
            onToggleDetails={() => setExpanded((open) => !open)}
            onRetryDetails={() => setReloadKey((key) => key + 1)}
            actions={
              <div className="mt-auto shrink-0 space-y-4 border-t border-slate-100 bg-white/80 px-6 py-4 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-900/80">
                <Button asChild type="button" variant="outline" className="w-full gap-2">
                  <Link href={`/group-portal/tracking?reference=${encodeURIComponent(order.tid)}`}>
                    <Route className="h-4 w-4" />
                    Track order
                  </Link>
                </Button>
                {String(detailedOrder.status).toUpperCase() === "APPROVED" && token && (
                  <TokenHandoff
                    orderId={order.id}
                    tid={order.tid}
                    token={token}
                    branchName={order.branchName ?? undefined}
                    onFulfilled={() => {
                      onChanged()
                      closeSheet()
                    }}
                  />
                )}
                {/* The branch owns its orders, so a group requester may amend a
                    still-pending one. The server re-checks the same rule and
                    tells the person who raised it. */}
                {isAwaitingCorrection(detailedOrder) && (
                  <OrderCorrectionNotice
                    comment={detailedOrder.correctionRequestNote}
                    returnedAt={detailedOrder.returnedForCorrectionAt}
                    audience="requester"
                  />
                )}
                {String(detailedOrder.status).toUpperCase() === "PENDING" && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() => onEdit(order)}
                  >
                    <Pencil className="h-4 w-4" />
                    Edit order
                  </Button>
                )}
                {onCancel && isCancellableGroupOrderStatus(String(detailedOrder.status ?? "")) && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full gap-2 border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/40"
                    onClick={() => onCancel(order)}
                  >
                    <Ban className="h-4 w-4" />
                    Cancel order
                  </Button>
                )}
                {isAwaitingCorrection(detailedOrder) && (
                  <Button
                    type="button"
                    className="w-full gap-2"
                    onClick={() => onResubmit({ ...order, correctionRequestNote: detailedOrder.correctionRequestNote ?? null })}
                  >
                    <Send className="h-4 w-4" />
                    Resubmit for approval
                  </Button>
                )}
                <RefundManagement
                  orderId={order.id}
                  orderTotalCents={detailedOrder.totalCents ?? null}
                  orderStatus={String(detailedOrder.status ?? "")}
                  orderFulfillmentStatus={detailedOrder.fulfillmentStatus ?? null}
                  fulfilledAt={typeof detailedOrder.fulfilledAt === "string" ? detailedOrder.fulfilledAt : null}
                  requesterRole="GROUP_ORDER_PORTAL"
                  allowRefundRequest
                  pricesHidden={Boolean(refundState.pricesHidden)}
                  initialOrderItems={matched?.orderItems ?? []}
                  refundAmountCents={refundState.refundAmountCents ?? null}
                  refundedAt={refundState.refundedAt ?? null}
                  refundReason={refundState.refundReason ?? null}
                  onRefundSuccess={onChanged}
                />
              </div>
            }
          />
        )}
      </SheetContent>
    </Sheet>
  )
}
