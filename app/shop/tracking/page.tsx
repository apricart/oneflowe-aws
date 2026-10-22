import { Suspense } from "react"

import { OrderTrackingWorkspace } from "@/components/orders/order-tracker"
import { ORDER_PORTAL_NAME } from "@/lib/role-display-names"

export const metadata = {
  title: "Track Order | Apricart OneFlowe",
  description: "Track the approval, delivery and payment status of an order.",
}

/** The Order Initiator's order tracker (plans/OF-TRACKING-requester-order-tracking.md). */
export default function ShopOrderTrackingPage() {
  return (
    <Suspense fallback={null}>
      <OrderTrackingWorkspace homeHref="/shop" homeLabel="Back to shopping" portalName={ORDER_PORTAL_NAME} />
    </Suspense>
  )
}
