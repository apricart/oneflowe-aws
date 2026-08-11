"use client"

import { useEffect, useState } from "react"
import { Bell, AlertTriangle, CheckCircle2, Info } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { DashboardNotification, useDashboardNotifications } from "@/lib/hooks/use-dashboard-notifications"

const severityIcon: Record<DashboardNotification["severity"], React.ReactNode> = {
  critical: <AlertTriangle className="h-4 w-4 text-red-500" />,
  warning: <AlertTriangle className="h-4 w-4 text-amber-500" />,
  info: <Info className="h-4 w-4 text-blue-500" />,
}

const severityTone: Record<DashboardNotification["severity"], string> = {
  critical: "border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 text-red-900 dark:text-red-200",
  warning: "border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-200",
  info: "border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100",
}

export function NotificationBell() {
  const { role, notifications, unreadCount, criticalCount, isLoading, markAllAsRead } = useDashboardNotifications()
  const [open, setOpen] = useState(false)
  const badgeCount = role === "ORDER_PORTAL" ? unreadCount : criticalCount

  useEffect(() => {
    if (open && !isLoading) {
      markAllAsRead()
    }
  }, [open, isLoading, markAllAsRead])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          {badgeCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white">
              {badgeCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" sideOffset={8} align="end">
        <div className="border-b px-4 py-3">
          <div className="text-sm font-semibold">Notifications</div>
          <p className="text-xs text-muted-foreground">Updates that need your attention.</p>
        </div>
        {(() => {
          if (isLoading) {
            return (
          <div className="space-y-3 p-4">
            {Array.from({ length: 3 }, (_, position) => `notification-menu-loading-${position + 1}`).map((skeletonKey) => (
              <Skeleton key={skeletonKey} className="h-16 w-full" />
            ))}
          </div>
        )
          }
          return (
          <ScrollArea className="max-h-80">
            <div className="divide-y">
              {notifications.length > 0 ? (
                notifications.map((notification) => (
                  <NotificationRow key={notification.id} notification={notification} compact />
                ))
              ) : (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  No notifications right now.
                </div>
              )}
            </div>
          </ScrollArea>
        )
        })()}
      </PopoverContent>
    </Popover>
  )
}

export function DashboardNotificationsPanel({ limit = 3, className }: Readonly<{ limit?: number; className?: string }>) {
  const { notifications, isLoading } = useDashboardNotifications()
  const visible = notifications.slice(0, limit)

  if (isLoading) {
    return (
      <Card className={cn("border-dashed", className)}>
        <CardHeader>
          <CardTitle className="text-base">Notifications</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 3 }, (_, position) => `notification-list-loading-${position + 1}`).map((skeletonKey) => (
            <Skeleton key={skeletonKey} className="h-20 w-full" />
          ))}
        </CardContent>
      </Card>
    )
  }

  if (!visible.length) {
    return null
  }

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Notifications</CardTitle>
        <Badge variant="secondary" className="text-xs">
          {notifications.length} total
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {visible.map((notification) => (
          <NotificationRow key={notification.id} notification={notification} />
        ))}
      </CardContent>
    </Card>
  )
}

export function NotificationRail({ limit = 1, className }: Readonly<{ limit?: number; className?: string }>) {
  const { notifications, isLoading } = useDashboardNotifications()
  const visible = notifications.slice(0, limit)

  if (isLoading) {
    return (
      <div className={cn("rounded-2xl border bg-card/60 px-4 py-3", className)}>
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: limit }, (_, position) => `notification-strip-loading-${position + 1}`).map((skeletonKey) => (
            <Skeleton key={skeletonKey} className="h-16 w-48 rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  if (!visible.length) {
    return null
  }

  return (
    <div className={cn("rounded-2xl border bg-white/70 dark:bg-slate-800/70 px-2 py-2 shadow-sm dark:shadow-slate-900/50", className)}>
      <ScrollArea className="w-full whitespace-nowrap">
        <div className="flex gap-3 pr-4">
          {visible.map((notification) => (
            <RailChip key={notification.id} notification={notification} />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function RailChip({ notification }: Readonly<{ notification: DashboardNotification }>) {
  const tone =
    (() => {
      if (notification.severity === "critical") {
        return "bg-red-50 dark:bg-red-900/30 border-red-100 dark:border-red-800 text-red-900 dark:text-red-200"
      }
      if (notification.severity === "warning") {
        return "bg-amber-50 dark:bg-amber-900/30 border-amber-100 dark:border-amber-800 text-amber-900 dark:text-amber-200"
      }
      return "bg-slate-50 dark:bg-slate-800 border-slate-100 dark:border-slate-700 text-slate-900 dark:text-slate-100"
    })()
  return (
    <div className={cn("flex min-w-[220px] max-w-full flex-col gap-1 whitespace-normal rounded-xl border px-4 py-3", tone)}>
      <div className="flex flex-wrap items-center gap-2">
        {severityIcon[notification.severity]}
        <p className="text-sm font-semibold leading-none">{notification.title}</p>
        {notification.tag && <Badge variant="secondary">{notification.tag}</Badge>}
      </div>
      <p className="break-words text-xs text-muted-foreground dark:text-slate-400">{notification.message}</p>
      {notification.cta && (
        <Button asChild size="sm" variant="ghost" className="h-7 self-start px-2 text-xs">
          <Link href={notification.cta.href}>{notification.cta.label}</Link>
        </Button>
      )}
    </div>
  )
}

function NotificationRow({ notification, compact }: Readonly<{ notification: DashboardNotification; compact?: boolean }>) {
  const Icon = severityIcon[notification.severity] || <CheckCircle2 className="h-4 w-4 text-emerald-500" />
  return (
    <div
      className={cn(
        "flex flex-col gap-2 border-l-4 px-4 py-3 text-sm",
        severityTone[notification.severity],
        compact && "rounded-none border-0 border-b last:border-b-0",
        !compact && "rounded-lg border",
      )}
    >
      <div className="flex items-start gap-2">
        {Icon}
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <p className="font-medium leading-none">{notification.title}</p>
            {notification.tag && (
              <span className="rounded-full bg-black/10 dark:bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-black/60 dark:text-white/70">
                {notification.tag}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{notification.message}</p>
        </div>
      </div>
      {notification.cta && (
        <div>
          <Button asChild size="sm" variant="outline" className="h-7 text-xs">
            <Link href={notification.cta.href}>{notification.cta.label}</Link>
          </Button>
        </div>
      )}
    </div>
  )
}

