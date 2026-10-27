import { redirect } from "next/navigation"

import { PaymentKpisDashboard } from "@/components/finance/payment-kpis-dashboard"
import { canReadFinanceKpis } from "@/lib/finance-access"
import { getProtectedPageSession } from "@/lib/server/page-session"

/**
 * Payment KPIs: Finance's landing page, and Super Admin's too. `proxy.ts`
 * gates the area to those roles; this refuses anyone else before the client
 * code is sent, and the endpoint behind it re-checks and fences Finance.
 */
export default async function FinancePage() {
  const pageSession = await getProtectedPageSession()
  if (pageSession.kind === "invalid") redirect("/login?reason=session-expired")
  if (pageSession.kind === "authenticated") {
    const role = (pageSession.session.user as { role?: string }).role
    if (!canReadFinanceKpis(role)) redirect("/dashboard")
  }
  return <PaymentKpisDashboard />
}
