"use client"

import Link from "next/link"
import { ArrowLeft, LifeBuoy } from "lucide-react"
import { useSession } from "next-auth/react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_PRIORITY_LABELS,
  SUPPORT_STATUS_LABELS,
  SUPPORT_STATUS_LABELS_APRICART,
  isSupportCategory,
  isSupportPriority,
  isSupportStatus,
  supportSideForRole,
} from "@/lib/support-thread"

/**
 * Shared presentation for the support area.
 *
 * A status reads differently depending on which side of the conversation you
 * are on — "Awaiting your reply" to a client is "Awaiting customer" to Apricart
 * — so the label is chosen from the viewer's own side rather than being a
 * single string on the row.
 */

export function useSupportSide() {
  const { data: session } = useSession()
  const role = (session?.user as { role?: string } | undefined)?.role
  return { role, side: supportSideForRole(role) }
}

const statusTone: Record<string, string> = {
  OPEN: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200",
  AWAITING_CUSTOMER: "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-700 dark:bg-blue-950/50 dark:text-blue-200",
  RESOLVED: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-200",
  CLOSED: "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
}

const priorityTone: Record<string, string> = {
  LOW: "border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300",
  NORMAL: "border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300",
  HIGH: "border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-700 dark:bg-orange-950/50 dark:text-orange-200",
  URGENT: "border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950/50 dark:text-red-200",
}

export function StatusBadge({ status, apricart }: Readonly<{ status: string; apricart: boolean }>) {
  const label = isSupportStatus(status)
    ? (apricart ? SUPPORT_STATUS_LABELS_APRICART : SUPPORT_STATUS_LABELS)[status]
    : status

  return (
    <Badge variant="outline" className={cn("font-semibold", statusTone[status] ?? statusTone.CLOSED)}>
      {label}
    </Badge>
  )
}

export function PriorityBadge({ priority }: Readonly<{ priority: string }>) {
  if (priority === "NORMAL" || priority === "LOW") return null
  const label = isSupportPriority(priority) ? SUPPORT_PRIORITY_LABELS[priority] : priority

  return (
    <Badge variant="outline" className={cn("font-semibold", priorityTone[priority] ?? priorityTone.NORMAL)}>
      {label}
    </Badge>
  )
}

export function CategoryLabel({ category }: Readonly<{ category: string }>) {
  return <>{isSupportCategory(category) ? SUPPORT_CATEGORY_LABELS[category] : category}</>
}

export function SupportHeader({
  title,
  subtitle,
  backHref,
  backLabel,
  actions,
}: Readonly<{
  title: string
  subtitle?: string
  backHref?: string
  backLabel?: string
  actions?: React.ReactNode
}>) {
  return (
    <header className="border-b bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-4">
        {backHref ? (
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link href={backHref}>
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              {backLabel || "Back"}
            </Link>
          </Button>
        ) : (
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300">
            <LifeBuoy className="h-5 w-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold text-slate-900 dark:text-slate-50">{title}</h1>
          {subtitle ? (
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
          ) : null}
        </div>
        {actions}
      </div>
    </header>
  )
}

/** Where a role goes when it leaves the support area. */
export function homeHrefForRole(role: string | undefined): { href: string; label: string } {
  if (role === "ORDER_PORTAL") return { href: "/shop", label: "Back to store" }
  if (role === "GROUP_ORDER_PORTAL") return { href: "/group-portal", label: "Back to portal" }
  return { href: "/dashboard", label: "Back to dashboard" }
}

export function formatWhen(value: string | Date | null | undefined): string {
  if (!value) return "—"
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return "—"

  return date.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
