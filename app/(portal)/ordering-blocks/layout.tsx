import type { ReactNode } from "react"

import { redirect } from "next/navigation"
import { AlertCircle } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { getSharedServerSession } from "@/lib/auth"
import { canUseOrderingBlocksPage } from "@/lib/ordering-blocks-access"

export const metadata = {
  title: "Ordering Blocks - Apricart OneFlowe",
  description: "Branches stopped from ordering by unpaid invoices, and Head Office exceptions",
}

/**
 * Head Office's Ordering Blocks page
 * (plans/OF-PAYMENT-CONTROL-head-office-ordering-blocks-page.md).
 *
 * Checked in a server layout, like `/head-count-requests`, so a caller who may
 * not be here gets an explicit refusal. Whether the organization blocks
 * ordering on unpaid invoices at all is the list endpoint's answer, which the
 * page renders. Neither this nor `proxy.ts` is the boundary — the list, grant
 * and revoke handlers each re-check.
 */
export default async function OrderingBlocksLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await getSharedServerSession()

  if (!session?.user) {
    redirect("/login")
  }

  if (!canUseOrderingBlocksPage((session.user as { role?: unknown }).role)) {
    return (
      <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center">
            <AlertCircle className="mx-auto mb-4 h-12 w-12 text-destructive" />
            <h1 className="text-xl font-semibold">Access denied</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Ordering blocks are managed by Head Office.
            </p>
          </CardContent>
        </Card>
      </main>
    )
  }

  return children
}
