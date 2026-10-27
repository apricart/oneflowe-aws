"use client"

import useSWR from "swr"
import { AlertTriangle, CalendarX } from "lucide-react"

import { fetcher } from "@/lib/fetcher"
import {
  formatPriceContractDay,
  priceContractDaysLabel,
} from "@/lib/price-contract-validity"
import { cn } from "@/lib/utils"

export const PRICE_CONTRACT_ALERTS_KEY = "/api/v1/price-contracts/alerts"

type PriceContractAlertItem = {
  organizationId: number
  name: string
  code: string | null
  validUntil: string
  daysLeft: number
  status: "expiring" | "expired"
}

type PriceContractAlertsResponse = { reminderDays: number; items: PriceContractAlertItem[] }

const STYLES = {
  expired: { surface: "bg-[#d32f2f] dark:bg-red-700", icon: CalendarX, role: "alert" as const },
  expiring: { surface: "bg-[#ed6c02] dark:bg-orange-700", icon: AlertTriangle, role: "status" as const },
}

function AlertSection({
  kind,
  items,
  reminderDays,
}: Readonly<{ kind: "expired" | "expiring"; items: PriceContractAlertItem[]; reminderDays: number }>) {
  const style = STYLES[kind]
  const Icon = style.icon
  const title = kind === "expired"
    ? `${items.length === 1 ? "A price contract has" : `${items.length} price contracts have`} expired`
    : `${items.length === 1 ? "A price contract expires" : `${items.length} price contracts expire`} within ${reminderDays} days`

  return (
    <section
      role={style.role}
      aria-live={style.role === "alert" ? "assertive" : "polite"}
      data-testid="price-contract-alert"
      data-kind={kind}
      className={cn("flex items-start gap-3 rounded-md px-4 py-3 text-white shadow-sm", style.surface)}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-semibold">{title}</p>
        <ul className="list-disc space-y-0.5 pl-5 text-sm">
          {items.map((item) => (
            <li key={item.organizationId}>
              <span className="font-semibold">{item.name}</span>
              {item.code ? ` (${item.code})` : ""} — valid until {formatPriceContractDay(item.validUntil)},{" "}
              {priceContractDaysLabel(item.daysLeft)}
            </li>
          ))}
        </ul>
        <p className="text-sm text-white/95">
          Please review these organizations&apos; prices and record the new validity date once renewed. Ordering is not affected.
        </p>
      </div>
    </section>
  )
}

/**
 * The embedded price contract alert on the Super Admin dashboard and the
 * executive workspace (plans/OF-PRICE-CONTRACT-organization-price-contract-validity.md).
 * The endpoint decides whose organizations the viewer sees; this only renders.
 * A reminder only — nothing here or behind it blocks an order.
 */
export function PriceContractAlerts({ className }: Readonly<{ className?: string }>) {
  const { data } = useSWR<PriceContractAlertsResponse>(PRICE_CONTRACT_ALERTS_KEY, fetcher, {
    revalidateOnFocus: false,
  })
  const items = data?.items ?? []
  if (items.length === 0) return null

  const expired = items.filter((item) => item.status === "expired")
  const expiring = items.filter((item) => item.status === "expiring")

  return (
    <div className={cn("space-y-3", className)}>
      {expired.length > 0 && <AlertSection kind="expired" items={expired} reminderDays={data!.reminderDays} />}
      {expiring.length > 0 && <AlertSection kind="expiring" items={expiring} reminderDays={data!.reminderDays} />}
    </div>
  )
}
