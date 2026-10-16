import { viewerReadRole } from "@/lib/viewer-access"
import type { ReactNode } from "react"

import { redirect } from "next/navigation"
import { AlertCircle } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { getSharedServerSession } from "@/lib/auth"
import { canReadBranchHeadCountRequests } from "@/lib/branch-head-count-access"

export const metadata = {
  title: "Head Count Requests - Apricart OneFlowe",
  description: "Branch head count requests awaiting Head Office",
}

/**
 * Branch head count requests: Branch Admin and Group User raise them, Head
 * Office decides them (plans/OF-BRANCH-head-count.md).
 *
 * Checked in a server layout, like `/join-requests`, so a caller who may not be
 * here gets an explicit refusal. Neither this nor `proxy.ts` is the boundary —
 * both handlers re-check through `lib/branch-head-count-access.ts`.
 */
export default async function HeadCountRequestsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await getSharedServerSession()

  if (!session?.user) {
    redirect("/login")
  }

  // An organization-wide Viewer reads the queue read-only; the decision
  // endpoint refuses it.
  if (!canReadBranchHeadCountRequests(viewerReadRole(session.user as any) ?? undefined)) {
    return (
      <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center">
            <AlertCircle className="mx-auto mb-4 h-12 w-12 text-destructive" />
            <h1 className="text-xl font-semibold">Access denied</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Branch head counts are requested by the branches and approved by Head Office.
            </p>
          </CardContent>
        </Card>
      </main>
    )
  }

  return children
}
