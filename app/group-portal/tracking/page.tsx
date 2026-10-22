import { Suspense } from "react"

import { OrderTrackingWorkspace } from "@/components/orders/order-tracker"
import { GROUP_ORDER_PORTAL_NAME } from "@/lib/role-display-names"

export const metadata = {
  title: "Track Order | Apricart OneFlowe",
  description: "Track the approval, delivery and payment status of a branch order.",
}

/** The Group Order Initiator's order tracker (plans/OF-TRACKING-requester-order-tracking.md). */
export default function GroupOrderTrackingPage() {
  return (
    <Suspense fallback={null}>
      <OrderTrackingWorkspace homeHref="/group-portal" homeLabel="Back to group ordering" portalName={GROUP_ORDER_PORTAL_NAME} />
    </Suspense>
  )
}
