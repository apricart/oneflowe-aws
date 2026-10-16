"use client"

import { useEffect, useRef, useState, type MouseEvent } from "react"
import { Building2, ChevronDown } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { UserBranchDisplay } from "@/lib/user-branch-display"

/** Delay before a hover-opened list closes, so the pointer can reach it. */
const HOVER_CLOSE_DELAY_MS = 150

type UserBranchCellProps = {
  display: UserBranchDisplay
  className?: string
}

/**
 * A user's Branch cell. One branch (or none) is plain text; several show
 * "Multiple", which lists every branch on hover and toggles it on click or
 * keyboard so it also works on touch screens. Clicks never reach the row,
 * which would otherwise open the user's detail drawer.
 */
export function UserBranchCell({ display, className }: Readonly<UserBranchCellProps>) {
  const [open, setOpen] = useState(false)
  // Opened by a click (or tap): stays open when the pointer leaves, until
  // clicked again, Escape, or a click outside.
  const [pinned, setPinned] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }, [])

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const openNow = () => {
    cancelClose()
    setOpen(true)
  }
  const closeSoon = () => {
    cancelClose()
    if (pinned) return
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS)
  }
  const stopRowClick = (event: MouseEvent) => event.stopPropagation()
  const togglePinned = (event: MouseEvent) => {
    event.stopPropagation()
    // Radix would toggle on its own, closing a list the hover just opened.
    event.preventDefault()
    cancelClose()
    const next = !pinned
    setPinned(next)
    setOpen(next)
  }
  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) setPinned(false)
  }

  if (display.kind !== "multiple") {
    return (
      <div className={cn("flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400", className)}>
        <Building2 className="h-3.5 w-3.5 opacity-60 shrink-0" />
        <span className="truncate max-w-[140px]" title={display.label}>{display.label}</span>
      </div>
    )
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-2 rounded-md px-1.5 py-0.5 -mx-1.5 text-sm font-medium text-indigo-600 dark:text-indigo-400",
            "hover:bg-indigo-50 dark:hover:bg-indigo-950/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
            className,
          )}
          aria-label={`${display.label}: ${display.branches.length} branches`}
          onClick={togglePinned}
          onMouseEnter={openNow}
          onMouseLeave={closeSoon}
        >
          <Building2 className="h-3.5 w-3.5 opacity-60 shrink-0" />
          <span>{display.label}</span>
          <span className="rounded-full bg-indigo-100 dark:bg-indigo-900/60 px-1.5 text-[10px] font-bold">
            {display.branches.length}
          </span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-0"
        onClick={stopRowClick}
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="border-b border-slate-100 dark:border-slate-800 px-3 py-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
          Assigned branches ({display.branches.length})
        </div>
        <ul className="max-h-64 overflow-y-auto py-1">
          {display.branches.map((branch) => (
            <li key={branch.id} className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300">
              <Building2 className="h-3.5 w-3.5 opacity-50 shrink-0" />
              <span className="truncate">{branch.name}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
