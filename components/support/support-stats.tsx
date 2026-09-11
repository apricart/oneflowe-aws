"use client"

import {
  AlertTriangle,
  CalendarPlus,
  CheckCircle2,
  Clock,
  Flame,
  Inbox,
  Mail,
  MessageSquare,
  Timer,
} from "lucide-react"

import { BankingKPICard } from "@/components/dashboard/banking-kpi-card"
import { useAPI } from "@/lib/hooks/use-api"
import {
  normalizeSupportStats,
  supportStatCards,
  type SupportStatKey,
} from "@/lib/support-stats"
import type { SupportSide, SupportStatus } from "@/lib/support-thread"

/**
 * The figures above the support queue.
 *
 * Which tiles appear and what they are called is decided by
 * `supportStatCards` in `lib/support-stats.ts`; this component only dresses
 * them. The numbers come from `/api/v1/support/stats`, which counts under the
 * caller's own visibility scope — never from the loaded page, which is
 * paginated at twenty and would make every figure wrong.
 */

type SupportStatStyle = { icon: typeof Inbox; gradient: string; iconBg: string }

const STAT_STYLES: Record<SupportStatKey, SupportStatStyle> = {
  total: { icon: Inbox, gradient: "from-indigo-500 to-violet-600", iconBg: "text-indigo-600 bg-indigo-600" },
  open: { icon: MessageSquare, gradient: "from-amber-500 to-orange-600", iconBg: "text-amber-600 bg-amber-600" },
  awaiting: { icon: Clock, gradient: "from-blue-500 to-indigo-600", iconBg: "text-blue-600 bg-blue-600" },
  unread: { icon: Mail, gradient: "from-sky-500 to-cyan-600", iconBg: "text-sky-600 bg-sky-600" },
  resolved: { icon: CheckCircle2, gradient: "from-emerald-500 to-teal-600", iconBg: "text-emerald-600 bg-emerald-600" },
  recent: { icon: CalendarPlus, gradient: "from-violet-500 to-purple-600", iconBg: "text-violet-600 bg-violet-600" },
  unanswered: { icon: AlertTriangle, gradient: "from-rose-500 to-red-600", iconBg: "text-rose-600 bg-rose-600" },
  urgent: { icon: Flame, gradient: "from-orange-500 to-red-600", iconBg: "text-orange-600 bg-orange-600" },
  firstResponse: { icon: Timer, gradient: "from-teal-500 to-emerald-600", iconBg: "text-teal-600 bg-teal-600" },
}

export function SupportStats({
  side,
  onSelectStatus,
}: Readonly<{
  side: SupportSide
  /**
   * Applies a tile's status to the list below it. Only tiles that stand for
   * exactly one status are clickable, so what the list shows always matches
   * the number that was clicked.
   */
  onSelectStatus?: (status: SupportStatus | "ALL") => void
}>) {
  const { data, isLoading } = useAPI<unknown>("/api/v1/support/stats", {
    // The same cadence as the list beside it, so a reply landing moves both.
    refreshInterval: 60_000,
  })

  const stats = normalizeSupportStats(data)
  const cards = supportStatCards(stats, side)
  // Nothing loaded yet reads as a row of dashes rather than a row of zeroes.
  const pending = isLoading && !data

  return (
    <section aria-label="Support summary" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((card, index) => {
        const style = STAT_STYLES[card.key]
        const filter = card.statusFilter
        const clickable = Boolean(onSelectStatus && filter)

        return (
          <BankingKPICard
            key={card.key}
            icon={style.icon}
            title={card.label}
            value={typeof card.value === "number" ? card.value.toLocaleString() : card.value}
            subtitle={card.subtitle}
            gradient={style.gradient}
            iconBg={style.iconBg}
            delay={index * 40}
            isLoading={pending}
            onClick={clickable ? () => onSelectStatus?.(filter!) : undefined}
          />
        )
      })}
    </section>
  )
}
