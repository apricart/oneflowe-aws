"use client"

import Link from "next/link"
import { LifeBuoy } from "lucide-react"

import { useAPI } from "@/lib/hooks/use-api"
import { normalizeSupportStats } from "@/lib/support-stats"
import { WAREHOUSE_SUPPORT_AREA } from "@/lib/warehouse-access"
import { cn } from "@/lib/utils"

/**
 * The warehouse menu's way into the support queue of the branches it serves
 * (plans/OF-WAREHOUSE-support-queue.md), with how many of those threads have
 * moved since it last read them.
 *
 * A link out of the workspace rather than a section of it: `/support` is the
 * shared support area every role uses. The count is the support stats
 * endpoint's own `unread`, which is scoped exactly as the queue is, so the
 * badge never counts a thread the queue would not show.
 */
export function WarehouseSupportLink({ className }: Readonly<{ className?: string }>) {
  const { data } = useAPI<unknown>("/api/v1/support/stats", { refreshInterval: 60_000 })
  const unread = data ? normalizeSupportStats(data).unread : 0

  return (
    <Link href={WAREHOUSE_SUPPORT_AREA} className={cn(className)}>
      <LifeBuoy size={18} aria-hidden="true" className="text-slate-400 dark:text-slate-500" />
      <span className="flex-1">Support</span>
      {unread > 0 && (
        <span
          className="rounded-full bg-blue-600 px-2 py-0.5 text-xs font-semibold text-white"
          aria-label={`${unread} support ${unread === 1 ? "request" : "requests"} with unread messages`}
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  )
}
