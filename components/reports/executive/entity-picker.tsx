"use client"

import * as React from "react"
import { Check, ChevronDown, Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { MAX_COMPARE_ENTITIES } from "@/lib/executive-analytics"

/**
 * The searchable multi-select behind both "which ones to compare" and "focus on
 * these products".
 *
 * The list it shows always comes from the server's scoped options endpoint, so
 * it can only ever name entities inside the caller's fence. Nothing here
 * filters for security — it is a convenience over an already-safe list.
 */

export type EntityOption = { key: string; label: string; hint?: string }

export function EntityPicker({
  noun, options, selected, onChange, loading, emptyLabel, className, icon,
}: Readonly<{
  noun: string
  options: EntityOption[]
  selected: string[]
  onChange: (next: string[]) => void
  loading: boolean
  /** Shown on the trigger when nothing is picked. */
  emptyLabel?: string
  className?: string
  icon?: React.ReactNode
}>) {
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState("")

  const visible = React.useMemo(() => {
    const needle = search.trim().toLowerCase()
    const matches = needle
      ? options.filter((option) => option.label.toLowerCase().includes(needle))
      : options
    return matches.slice(0, 200)
  }, [options, search])

  const atCap = selected.length >= MAX_COMPARE_ENTITIES

  const toggle = (key: string) => {
    if (selected.includes(key)) onChange(selected.filter((entry) => entry !== key))
    else if (!atCap) onChange([...selected, key])
  }

  const triggerLabel = (() => {
    if (loading) return "Loading…"
    if (selected.length === 0) return emptyLabel ?? `All ${noun}`
    if (selected.length === 1) {
      return options.find((option) => option.key === selected[0])?.label ?? `1 ${noun}`
    }
    return `${selected.length} of ${options.length} ${noun}`
  })()

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("h-9 justify-between rounded-xl text-xs font-medium", className ?? "w-[260px]")}
          disabled={loading}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {icon}
            <span className="truncate">{triggerLabel}</span>
          </span>
          <ChevronDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px] p-0">
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
          <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`Search ${noun}…`}
            className="h-7 border-0 p-0 text-xs shadow-none focus-visible:ring-0"
          />
          {selected.length > 0 ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="shrink-0 text-[11px] font-semibold text-slate-500 hover:text-slate-700"
            >
              Clear
            </button>
          ) : null}
        </div>

        <ul className="max-h-[300px] overflow-y-auto py-1">
          {visible.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-slate-500">
              No {noun} with activity in the selected period.
            </li>
          ) : null}
          {visible.map((option) => {
            const checked = selected.includes(option.key)
            const blocked = !checked && atCap
            return (
              <li key={option.key}>
                <button
                  type="button"
                  onClick={() => toggle(option.key)}
                  disabled={blocked}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs transition",
                    blocked ? "cursor-not-allowed opacity-40" : "hover:bg-slate-50 dark:hover:bg-slate-800",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                      checked ? "border-indigo-500 bg-indigo-500 text-white" : "border-slate-300 dark:border-slate-600",
                    )}
                  >
                    {checked ? <Check className="h-2.5 w-2.5" /> : null}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-slate-700 dark:text-slate-200">{option.label}</span>
                    {option.hint ? (
                      <span className="block truncate text-[10px] text-slate-500 dark:text-slate-400">{option.hint}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        {atCap ? (
          <p className="border-t border-slate-200 px-3 py-2 text-[10px] text-amber-600 dark:border-slate-700 dark:text-amber-400">
            {MAX_COMPARE_ENTITIES} is the most that can be selected at once.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
