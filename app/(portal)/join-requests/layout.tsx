import { viewerReadRole } from "@/lib/viewer-access"
import type { ReactNode } from "react"

import { redirect } from "next/navigation"
import { AlertCircle } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { getSharedServerSession } from "@/lib/auth"
import { canManageJoinRequests } from "@/lib/organization-join-access"

/**
 * The join queue belongs to Head Office alone.
 *
 * Checked in a server layout, as `app/(portal)/users/layout.tsx` does, so a
 * signed-in caller who may not be here gets an explicit refusal rather than a UI
 * that mounts and then fails every request. Neither this nor the `proxy.ts`
 * redirect is the authorization boundary — the route handlers re-check on every
 * call through the same `canManageJoinRequests`/`JOIN_REQUEST_MANAGEMENT_ROLES`.
 */
export default async function JoinRequestsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await getSharedServerSession()

  if (!session?.user) {
    redirect("/login")
  }

  // An organization-wide Viewer reads the queue read-only; every decision
  // endpoint refuses it.
  if (!canManageJoinRequests(viewerReadRole(session.user as any) ?? undefined)) {
    return (
      <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center">
            <AlertCircle className="mx-auto mb-4 h-12 w-12 text-destructive" />
            <h1 className="text-xl font-semibold">Access denied</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Only Head Office can issue a join code or decide who joins this organization.
            </p>
          </CardContent>
        </Card>
      </main>
    )
  }

  return children
}
