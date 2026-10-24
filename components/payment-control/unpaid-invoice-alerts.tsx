"use client"

import { useState } from "react"
import { useSession } from "next-auth/react"
import { AlertTriangle, Ban, X } from "lucide-react"

import { useUnpaidInvoiceAlerts } from "@/lib/hooks/use-unpaid-invoice-alerts"
import {
  readDismissedUnpaidInvoiceAlert,
  receivesUnpaidInvoiceAlerts,
  rememberDismissedUnpaidInvoiceAlert,
  unpaidInvoiceAlertsFor,
  type UnpaidInvoiceAlert,
  type UnpaidInvoiceAlertKind,
} from "@/lib/unpaid-invoice-alerts"

const PLACEMENT_WRAPPERS = {
  /** Inside the admin portal's content area, above the page. */
  portal: "mb-4 space-y-3",
  /** Above a storefront page, aligned with its header. */
  storefront: "space-y-3 bg-slate-50 px-4 pt-4 dark:bg-slate-950",
} as const

const KIND_STYLES: Record<UnpaidInvoiceAlertKind, { surface: string; icon: typeof AlertTriangle; role: "alert" | "status" }> = {
  blocked: { surface: "bg-[#d32f2f] dark:bg-red-700", icon: Ban, role: "alert" },
  lastOrder: { surface: "bg-[#ed6c02] dark:bg-orange-700", icon: AlertTriangle, role: "status" },
}

function readDismissed(): Record<UnpaidInvoiceAlertKind, string | null> {
  return { blocked: readDismissedUnpaidInvoiceAlert("blocked"), lastOrder: readDismissedUnpaidInvoiceAlert("lastOrder") }
}

function AlertBanner({ alert, centred, onDismiss }: Readonly<{ alert: UnpaidInvoiceAlert; centred: boolean; onDismiss: () => void }>) {
  const style = KIND_STYLES[alert.kind]
  const Icon = style.icon
  return (
    <section
      role={style.role}
      aria-live={style.role === "alert" ? "assertive" : "polite"}
      data-testid="unpaid-invoice-alert"
      data-kind={alert.kind}
      className={`flex items-start gap-3 rounded-md px-4 py-3 text-white shadow-sm ${style.surface} ${centred ? "mx-auto max-w-7xl" : ""}`}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-semibold">{alert.title}</p>
        {alert.branches.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {alert.branches.map((branch) => (
              <li key={branch.branchId}>
                <span className="font-semibold">{branch.name}</span> — {branch.detail}
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-white/95">{alert.body}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss this alert"
        className="-m-1 shrink-0 rounded-md p-1 text-white/90 transition hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <X className="h-5 w-5" aria-hidden="true" />
      </button>
    </section>
  )
}

/**
 * Tells the people who order for a branch, or approve its orders, that it is
 * blocked by unpaid invoices or one unpaid invoice short of it
 * (plans/OF-PAYMENT-CONTROL-unpaid-invoice-alerts.md). Embedded alerts, not a
 * popup; closing one keeps it closed for this browser session until its
 * branches or counts change. Presentation only — the order gate is the control.
 */
export function UnpaidInvoiceAlerts({ placement = "portal" }: Readonly<{ placement?: keyof typeof PLACEMENT_WRAPPERS }>) {
  const { data: session, status } = useSession()
  const role = (session?.user as { role?: string } | undefined)?.role
  const enabled = status === "authenticated" && receivesUnpaidInvoiceAlerts(role)
  const { data: view } = useUnpaidInvoiceAlerts({ enabled })
  // Nothing renders before the alerts arrive, so reading storage on the
  // first client render cannot disagree with the server's markup.
  const [dismissed, setDismissed] = useState(readDismissed)

  const alerts = (enabled ? unpaidInvoiceAlertsFor(view, role) : [])
    .filter((alert) => alert.dismissalKey !== dismissed[alert.kind])
  if (alerts.length === 0) return null

  const dismiss = (alert: UnpaidInvoiceAlert) => {
    rememberDismissedUnpaidInvoiceAlert(alert.kind, alert.dismissalKey)
    setDismissed((current) => ({ ...current, [alert.kind]: alert.dismissalKey }))
  }

  return (
    <div className={PLACEMENT_WRAPPERS[placement]}>
      {alerts.map((alert) => (
        <AlertBanner key={alert.kind} alert={alert} centred={placement === "storefront"} onDismiss={() => dismiss(alert)} />
      ))}
    </div>
  )
}
