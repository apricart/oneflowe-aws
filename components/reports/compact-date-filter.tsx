"use client"

import * as React from "react"
import { Calendar as CalendarIcon,ChevronDown,Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Popover,PopoverContent,PopoverTrigger } from "@/components/ui/popover"
import { Calendar } from "@/components/ui/calendar"
import { presets,getPresetLabel,FilterPreset } from "@/components/dashboard/global-date-filter"
import type { DateRange } from "@/lib/hooks/use-sales-performance"

interface CompactDateFilterProps {
    value: DateRange | null
    onChange: (range: DateRange | null, preset: FilterPreset, compare?: boolean) => void
    activePreset: FilterPreset
    className?: string
    compare?: boolean
}

export function CompactDateFilter({ value, onChange, activePreset, className, compare }: Readonly<CompactDateFilterProps>) {
    const [calendarOpen, setCalendarOpen] = React.useState(false)

    const handleSelectPreset = (preset: FilterPreset) => {
        if (preset === "custom") {
            setCalendarOpen(true)
            return
        }
        onChange(null, preset, compare)
    }

    const selectedLabel = getPresetLabel(activePreset, value)

    return (
        <div className={cn("flex items-center gap-2", className)}>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        className={cn(
                            "h-10 px-4 border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm hover:bg-slate-50 dark:hover:bg-slate-800 transition-all rounded-xl gap-2.5 font-bold text-xs text-slate-700 dark:text-slate-300 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                            compare && "border-indigo-500/50 bg-indigo-50/10"
                        )}
                    >
                        <CalendarIcon className={cn("h-4 w-4 shrink-0", compare ? "text-indigo-600" : "text-indigo-500")} />
                        <span className="truncate max-w-[150px]">{selectedLabel}{compare && " (vs Prev)"}</span>
                        <ChevronDown className="h-3.5 w-3.5 opacity-50 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-60 rounded-2xl border-slate-200 dark:border-slate-800 shadow-2xl p-1.5 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md">
                    <div className="px-2 py-1.5 mb-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Time Range</span>
                    </div>
                    {presets.map((p) => (
                        <DropdownMenuItem
                            key={p.id}
                            onClick={() => handleSelectPreset(p.id)}
                            className={cn(
                                "rounded-xl px-3 py-2.5 text-xs font-semibold cursor-pointer flex items-center justify-between mb-0.5 transition-colors",
                                activePreset === p.id
                                    ? "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400"
                                    : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                            )}
                        >
                            {p.label}
                            {activePreset === p.id && <Check className="h-3.5 w-3.5" />}
                        </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator className="my-1.5 bg-slate-100 dark:bg-slate-800" />

                    <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                        <PopoverTrigger asChild>
                            <DropdownMenuItem
                                onSelect={(e) => e.preventDefault()}
                                className={cn(
                                    "rounded-xl px-3 py-2.5 text-xs font-semibold cursor-pointer flex items-center gap-2.5 mb-0.5 transition-colors",
                                    activePreset === "custom"
                                        ? "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400"
                                        : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                                )}
                            >
                                <CalendarIcon className="h-4 w-4 text-indigo-500" />
                                Custom Range...
                            </DropdownMenuItem>
                        </PopoverTrigger>
                        <PopoverContent
                            className="w-auto p-0 rounded-3xl border-slate-200 dark:border-slate-800 shadow-[0_20px_50px_rgba(0,0,0,0.2)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.5)] overflow-hidden"
                            align="start"
                            side="bottom"
                            sideOffset={8}
                            onInteractOutside={() => setCalendarOpen(false)}
                            onOpenAutoFocus={(e) => e.preventDefault()}
                        >
                            <div>
                                <Calendar
                                    autoFocus
                                    mode="range"
                                    defaultMonth={value?.startDate || new Date()}
                                    selected={{
                                        from: value?.startDate,
                                        to: value?.endDate,
                                    }}
                                    onSelect={(range: any) => {
                                        if (range?.from && range?.to) {
                                            onChange({ startDate: range.from, endDate: range.to }, "custom", compare)
                                            setCalendarOpen(false)
                                        }
                                    }}
                                    numberOfMonths={2}
                                    className="p-4 bg-white dark:bg-slate-900"
                                />
                            </div>
                        </PopoverContent>
                    </Popover>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    )
}
