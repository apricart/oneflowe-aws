import { redirect } from "next/navigation"

import { DeliveryDashboard } from "@/components/delivery-dashboard/delivery-dashboard"
import { getProtectedPageSession } from "@/lib/server/page-session"

/**
 * The management delivery dashboard inside the admin shell, for Super Admin.
 * `proxy.ts` gates the area to Super Admin; this refuses anyone else before
 * the client code is sent, and both endpoints re-check the role.
 */
export default async function DeliveryDashboardPage() {
  const pageSession = await getProtectedPageSession()
  if (pageSession.kind === "invalid") redirect("/login?reason=session-expired")
  if (pageSession.kind === "authenticated") {
    const role = (pageSession.session.user as { role?: string }).role
    if (role !== "SUPER_ADMIN") redirect("/dashboard")
  }
  return <DeliveryDashboard />
}
