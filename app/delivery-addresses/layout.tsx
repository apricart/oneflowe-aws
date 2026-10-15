import { viewerReadRole } from "@/lib/viewer-access"
import type { ReactNode } from "react"
import { redirect } from "next/navigation"
import { AlertCircle } from "lucide-react"

import { PortalShell } from "@/components/shell/portal-shell"
import { SessionGuard } from "@/components/shell/session-guard"
import { SessionUnavailable } from "@/components/shell/session-unavailable"
import { Card, CardContent } from "@/components/ui/card"
import { canReadDeliveryAddresses } from "@/lib/delivery-address-access"
import { usesPortalChrome } from "@/lib/portal-chrome"
import { getProtectedPageSession } from "@/lib/server/page-session"

/**
 * Delivery addresses are shared between portals, like `/support` and
 * `/invoices`, and for the same reason: the branch that needs a destination
 * lives in `/shop` or `/group-portal`, and the Head Office that approves it
 * lives in the admin shell. So the area sits outside `(portal)` and the shell
 * is chosen per role by `lib/portal-chrome.ts` — a requester reaching this page
 * from the store does not land inside the administrator's navigation, and an
 * administrator does not lose theirs.
 *
 * Who may be here at all is `canReadDeliveryAddresses`: the four roles that may
 * request one plus the Head Office that decides them. `SUPER_ADMIN` and
 * `VIEWER` are refused — neither acts for a branch, and a tenant's delivery
 * arrangements are the tenant's own.
 *
 * Neither this check nor the `proxy.ts` allowlist is the authorization
 * boundary. Every handler behind this page re-checks on every call through the
 * same allowlists, and the branch set is always re-resolved from the session.
 */
export const metadata = {
  title: "Delivery Addresses - Apricart OneFlowe",
  description: "Where a branch can have its orders delivered",
}

export default async function DeliveryAddressesLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const pageSession = await getProtectedPageSession()
  if (pageSession.kind === "invalid") redirect("/login?reason=session-expired")
  if (pageSession.kind === "unavailable") return <SessionUnavailable />

  const role = (pageSession.session.user as { role?: string } | undefined)?.role

  // An organization-wide Viewer reads the tenant's list, read-only.
  const readRole = viewerReadRole(pageSession.session.user as { role?: string } | undefined ?? {})
  const body = canReadDeliveryAddresses(readRole) ? children : (
    <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardContent className="p-8 text-center">
          <AlertCircle className="mx-auto mb-4 h-12 w-12 text-destructive" />
          <h1 className="text-xl font-semibold">Access denied</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Delivery addresses are managed by the branches that use them and approved by Head
            Office.
          </p>
        </CardContent>
      </Card>
    </main>
  )

  if (usesPortalChrome(role)) {
    // No prefetch: this page reads none of the portal's cached order, user or
    // branch lists.
    return <PortalShell preload={false}>{body}</PortalShell>
  }

  // The root layout already provides the session, SWR and toast providers.
  return (
    <SessionGuard>
      <main className="min-h-svh bg-background dark:bg-slate-950">{body}</main>
    </SessionGuard>
  )
}
