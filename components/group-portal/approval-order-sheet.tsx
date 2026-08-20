"use client"

import { useState } from "react"
import useSWR from "swr"
import { Check, X } from "lucide-react"

import { OrderDetailPanel, type OrderDetails } from "@/components/orders/order-detail-panel"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { fetcher } from "@/lib/fetcher"

import { type ApprovalOrder, isPending } from "./approval-types"

type Props = Readonly<{
  order: ApprovalOrder | null
  onClose: () => void
  onDecide: (orderIds: number[], decision: "approve" | "reject") => void
  busy: boolean
}>

/**
 * The order detail drawer for the Group User, showing the same panel a Branch
 * Admin sees when opening one of its own orders.
 *
 * The detail is read from `/api/v1/orders/{id}`, which resolves this role
 * against its branch assignments server-side, so opening a row can never reveal
 * an order outside the approver's scope. The row the user clicked is used for
 * the first paint and the fetched record fills in the fields the queue does not
 * carry, such as the branch address and payment state.
 *
 * The fulfilment token is deliberately not repeated here: the queue row already
 * offers the copy and hand-off controls once an order is approved.
 */
export function ApprovalOrderSheet({ order, onClose, onDecide, busy }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const { data, error, isLoading } = useSWR<{ item?: OrderDetails & Record<string, unknown> }>(
    order ? [`/api/v1/orders/${order.id}`, reloadKey] : null,
    ([url]: [string, number]) => fetcher(url),
  )

  const fetched = data?.item
  // The queue row paints immediately; the fetched record only adds detail.
  const detailedOrder = { ...order, ...(fetched?.id === order?.id ? fetched : {}) }
  const decidable = order ? isPending(order) : false

  const closeSheet = () => {
    setExpanded(false)
    onClose()
  }

  const decide = (decision: "approve" | "reject") => {
    if (!order) return
    onDecide([order.id], decision)
    closeSheet()
  }

  return (
    <Sheet open={Boolean(order)} onOpenChange={(open) => !open && closeSheet()}>
      <SheetContent className="w-full overflow-y-auto border-l-0 bg-[#fdfdfd] p-0 shadow-[0_0_50px_rgba(0,0,0,0.1)] dark:bg-[#0b0f19] sm:max-w-md">
        <SheetHeader className="sr-only p-0">
          <SheetTitle>Order details</SheetTitle>
          <SheetDescription>
            {order
              ? `Review status, branch information, and line items for order ${order.tid}.`
              : "Review the order status, branch information, and line items."}
          </SheetDescription>
        </SheetHeader>

        {order && (
          <OrderDetailPanel
            order={detailedOrder}
            details={fetched?.id === order.id ? fetched : null}
            detailsExpanded={expanded}
            detailsLoading={isLoading}
            detailsError={error ? (error as Error)?.message || "Unable to load order details" : null}
            onToggleDetails={() => setExpanded((open) => !open)}
            onRetryDetails={() => setReloadKey((key) => key + 1)}
            actions={decidable ? (
              <div className="mt-auto shrink-0 space-y-3 rounded-t-[2.5rem] border-t border-slate-100 bg-white/80 p-6 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-900/80">
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => decide("reject")}
                    className="h-12 flex-1 gap-2 rounded-xl border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-800 dark:hover:bg-rose-900/20"
                  >
                    <X className="h-4 w-4" />
                    Reject
                  </Button>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => decide("approve")}
                    className="h-12 flex-1 gap-2 rounded-xl bg-emerald-600 font-bold text-white shadow-lg shadow-emerald-600/20 hover:bg-emerald-500"
                  >
                    <Check className="h-4 w-4" />
                    Approve
                  </Button>
                </div>
              </div>
            ) : null}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}
