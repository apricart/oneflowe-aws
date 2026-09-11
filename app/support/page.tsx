import { Suspense } from "react"

import { SupportList } from "@/components/support/support-list"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * The support directory, shared by every role.
 *
 * What each caller sees is decided by the endpoint behind it, not here — this
 * page renders the same shell for an Order Portal user and for Apricart.
 */
export default function SupportPage() {
  return (
    <Suspense fallback={<Skeleton className="m-4 h-64 rounded-lg" />}>
      <SupportList />
    </Suspense>
  )
}
