"use client"

import { useState } from "react"
import useSWR from "swr"
import { formatDistanceToNow } from "date-fns"
import { Bell } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { fetcher } from "@/lib/fetcher"
import { cn } from "@/lib/utils"
import type { WarehouseNotificationItem } from "@/lib/warehouse-order-notifications"

const ENDPOINT = "/api/v1/warehouse/notifications"

type Response = { items: WarehouseNotificationItem[]; unreadCount: number }

function when(value: string | null): string {
  if (!value) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "" : formatDistanceToNow(date, { addSuffix: true })
}

/**
 * The warehouse's bell: order-stage notices for the branches it serves
 * (plans/OF-WAREHOUSE-order-stage-notifications.md). Opening it marks them read.
 * A notice links to the order queue only while its order is in that queue.
 */
export function WarehouseNotificationBell() {
  const [open, setOpen] = useState(false)
  const { data, error, isLoading, mutate } = useSWR<Response>(ENDPOINT, fetcher, { refreshInterval: 60_000 })
  const unread = data?.unreadCount ?? 0

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next || unread === 0) return
    void fetch(ENDPOINT, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark-all-read" }),
    })
      .then(() => mutate())
      .catch(() => undefined)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell className="h-5 w-5" aria-hidden="true" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white">
              {unread > 30 ? "30+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" sideOffset={8} align="end">
        <div className="border-b px-4 py-3">
          <div className="text-sm font-semibold">Notifications</div>
          <p className="text-xs text-muted-foreground">Order updates for the branches you serve.</p>
        </div>
        {error && <p role="alert" className="p-4 text-sm text-rose-700 dark:text-rose-300">Notifications could not be loaded.</p>}
        {!error && isLoading && !data && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
        {!error && data && data.items.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">No notifications yet.</p>
        )}
        {!error && data && data.items.length > 0 && (
          <ScrollArea className="max-h-96">
            <ul className="divide-y">
              {data.items.map((item) => (
                <li key={item.id} className={cn("px-4 py-3", !item.read && "bg-blue-50/60 dark:bg-blue-950/20")}>
                  <p className="text-sm font-medium text-slate-900 dark:text-white">{item.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{item.message}</p>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>{when(item.createdAt)}</span>
                    {item.href && (
                      <a href={item.href} onClick={() => setOpen(false)} className="font-medium text-blue-700 hover:underline dark:text-blue-300">
                        Open order queue
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  )
}
