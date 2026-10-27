"use client"

import { useSession } from "next-auth/react"
import useSWR from "swr"
import { Gauge } from "lucide-react"

import { OrderPortalProfileMenu } from "@/components/auth/order-portal-profile-menu"
import { DeliveryDashboard } from "@/components/delivery-dashboard/delivery-dashboard"
import { EXECUTIVE_APPROVALS_KEY_PREFIX, ExecutiveApprovals } from "@/components/executive-approvals/executive-approvals"
import { PriceContractAlerts } from "@/components/price-contracts/price-contract-alerts"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { APRICART_EXECUTIVE_LABEL } from "@/lib/apricart-executive-access"
import type { ExecutiveApprovalCounts } from "@/lib/executive-approval-query"
import { fetcher } from "@/lib/fetcher"

/**
 * The Apricart Executive's workspace: the delivery dashboard, and the Order
 * Desk orders waiting for their approval, under a header of its own.
 * Self-contained, like the Order Desk — every call made from here is on the
 * role's allowlist (`lib/apricart-executive-access.ts`).
 */
export function ExecutiveWorkspace() {
  const { data: session } = useSession()
  const user = session?.user as { fullName?: string; name?: string; email?: string } | undefined
  // One row is enough: only the tab counts are read.
  const { data: approvals } = useSWR<{ counts: ExecutiveApprovalCounts }>(
    `${EXECUTIVE_APPROVALS_KEY_PREFIX}?status=awaiting_approval&limit=1`,
    fetcher,
  )
  const waiting = approvals?.counts.awaiting_approval ?? 0

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur dark:bg-slate-900/95">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-sm">
              <Gauge className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-slate-900 dark:text-white">Apricart OneFlowe</h1>
              <p className="truncate text-xs text-muted-foreground">Delivery performance and Order Desk approvals</p>
            </div>
          </div>
          <OrderPortalProfileMenu
            name={user?.fullName || user?.name || user?.email || APRICART_EXECUTIVE_LABEL}
            email={user?.email}
            role={APRICART_EXECUTIVE_LABEL}
          />
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <PriceContractAlerts className="mb-6" />
        <Tabs defaultValue="delivery" className="space-y-6">
          <TabsList>
            <TabsTrigger value="delivery">Delivery</TabsTrigger>
            <TabsTrigger value="approvals" className="gap-2">
              Approvals
              {waiting > 0 && (
                <span className="rounded-full bg-indigo-600 px-1.5 text-xs font-semibold tabular-nums text-white">
                  <span className="sr-only">, waiting: </span>{waiting}
                </span>
              )}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="delivery">
            <DeliveryDashboard />
          </TabsContent>
          <TabsContent value="approvals">
            <ExecutiveApprovals />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}
