"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { format, subDays, startOfDay, endOfDay, startOfMonth, endOfMonth, startOfYear, endOfYear } from "date-fns"
import type { DateRange } from "@/lib/hooks/use-sales-performance"

export type MonthPreset = "jan" | "feb" | "mar" | "apr" | "may" | "jun" | "jul" | "aug" | "sep" | "oct" | "nov" | "dec"
export type FilterPreset = "today" | "3d" | "7d" | "monthly" | "thisMonth" | "yearly" | "all" | "custom" | MonthPreset
type CalendarRangeDraft = { from: Date | undefined; to?: Date } | undefined

export interface GlobalDateFilterChange {
    range: DateRange | null
    preset: FilterPreset
    compare?: boolean
    compareRange?: DateRange | null
    months?: number[]
    years?: number[]
    compareMonths?: number[]
    compareYears?: number[]
}

interface GlobalDateFilterProps {
    value: DateRange | null
    onChange: (change: GlobalDateFilterChange) => void
    activePreset: FilterPreset
    className?: string
    hidePresets?: boolean
    compare?: boolean
    compareRange?: DateRange | null
    months?: number[]
    years?: number[]
    compareMonths?: number[]
    compareYears?: number[]
    customRangeOnly?: boolean
}

export const presets: { id: FilterPreset; label: string }[] = [
    { id: "today", label: "Today" },
    { id: "3d", label: "3 Days" },
    { id: "7d", label: "7 Days" },
    { id: "thisMonth", label: "This Month" },
    { id: "yearly", label: "This Year" },
    { id: "all", label: "All Time" },
]

export const monthPresets: { id: MonthPreset; label: string }[] = [
    { id: "jan", label: "January" },
    { id: "feb", label: "February" },
    { id: "mar", label: "March" },
    { id: "apr", label: "April" },
    { id: "may", label: "May" },
    { id: "jun", label: "June" },
    { id: "jul", label: "July" },
    { id: "aug", label: "August" },
    { id: "sep", label: "September" },
    { id: "oct", label: "October" },
    { id: "nov", label: "November" },
    { id: "dec", label: "December" },
]



export function getPresetLabel(preset: FilterPreset, range?: DateRange | null): string {
    if (preset === "custom" && range) {
        return `${format(range.startDate, "dd MMM yyyy")} – ${format(range.endDate, "dd MMM yyyy")}`
    }
    const allPresets = [...presets, ...monthPresets, { id: "custom", label: "Custom" }]
    return allPresets.find(p => p.id === preset)?.label || "Selected Period"
}

export function getPresetRange(preset: FilterPreset): DateRange {
    const now = new Date()
    const year = now.getFullYear()

    // Check if it's a month preset
    const monthIndex = monthPresets.findIndex(m => m.id === preset)
    if (monthIndex !== -1) {
        const start = new Date(year, monthIndex, 1)
        return { startDate: startOfDay(start), endDate: endOfDay(endOfMonth(start)) }
    }

    switch (preset) {
        case "today":
            return { startDate: startOfDay(now), endDate: endOfDay(now) }
        case "3d":
            return { startDate: startOfDay(subDays(now, 2)), endDate: endOfDay(now) }
        case "7d":
            return { startDate: startOfDay(subDays(now, 6)), endDate: endOfDay(now) }
        case "monthly":
        case "thisMonth":
            return { startDate: startOfMonth(now), endDate: endOfMonth(now) }
        case "yearly":
            return { startDate: startOfYear(now), endDate: endOfYear(now) }
        case "all":
            // Fallback if earliestDate is not provided by the component state
            // Default to start of 2024 as a more reasonable recent beginning for this system
            return { startDate: new Date("2024-01-01"), endDate: endOfDay(now) }
        default:
            return { startDate: startOfDay(now), endDate: endOfDay(now) }
    }
}

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar, CALENDAR_DROPDOWN_LAYER_ATTR } from "@/components/ui/calendar"
import { Check, ChevronDown, Calendar as CalendarIcon, Calculator } from "lucide-react"
import { cn } from "@/lib/utils"

const EMPTY_ARRAY: number[] = []
const DATE_FILTER_LAYER_ATTR = "data-global-date-filter-layer"

const isInsideDateFilterLayer = (target: EventTarget | null) => {
    return target instanceof HTMLElement && Boolean(
        target.closest(`[${DATE_FILTER_LAYER_ATTR}], [${CALENDAR_DROPDOWN_LAYER_ATTR}]`)
    )
}

export function GlobalDateFilter({ 
    value, onChange, activePreset, className, hidePresets, 
    compare, compareRange, months = EMPTY_ARRAY, years = EMPTY_ARRAY, 
    compareMonths = EMPTY_ARRAY, compareYears = EMPTY_ARRAY,
    customRangeOnly = false
}: Readonly<GlobalDateFilterProps>) {
    const filterRootRef = useRef<HTMLDivElement>(null)
    const [filterOpen, setFilterOpen] = useState(false)
    const [calendarOpen, setCalendarOpen] = useState(false)
    const [compareCalendarOpen, setCompareCalendarOpen] = useState(false)
    const [calendarDraft, setCalendarDraft] = useState<CalendarRangeDraft>()
    const [compareCalendarDraft, setCompareCalendarDraft] = useState<CalendarRangeDraft>()
    const [earliestDate, setEarliestDate] = useState<Date | null>(null)

    useEffect(() => {
        const fetchEarliest = async () => {
            try {
                const res = await fetch('/api/v1/analytics/earliest-record')
                const data = await res.json()
                if (data.earliestDate) {
                    setEarliestDate(new Date(data.earliestDate))
                }
            } catch (e) {
                console.error("Failed to fetch earliest record:", e)
            }
        }
        fetchEarliest()
    }, [])

    const [monthsOpen, setMonthsOpen] = useState(false)
    const [yearsOpen, setYearsOpen] = useState(false)
    const [compareMonthsOpen, setCompareMonthsOpen] = useState(false)
    const [compareYearsOpen, setCompareYearsOpen] = useState(false)

    const closeFilter = useCallback(() => {
        setFilterOpen(false)
        setCalendarOpen(false)
        setCompareCalendarOpen(false)
        setMonthsOpen(false)
        setYearsOpen(false)
        setCompareMonthsOpen(false)
        setCompareYearsOpen(false)
    }, [])

    const handleCalendarOpenChange = useCallback((open: boolean) => {
        setCalendarOpen(open)
        if (open) {
            setCalendarDraft(undefined)
        }
    }, [])

    const handleCompareCalendarOpenChange = useCallback((open: boolean) => {
        setCompareCalendarOpen(open)
        if (open) {
            setCompareCalendarDraft(undefined)
        }
    }, [])

    const openMainCalendarFromMenu = useCallback((event?: Event) => {
        event?.preventDefault()
        setCalendarDraft(undefined)
        setCalendarOpen(true)
        setFilterOpen(true)
    }, [])

    const preventDropdownDismissForDateLayer = useCallback((event: { target: EventTarget | null; preventDefault: () => void }) => {
        if (isInsideDateFilterLayer(event.target)) {
            event.preventDefault()
        }
    }, [])

    useEffect(() => {
        if (!filterOpen) return

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target

            if (
                (target instanceof Node && filterRootRef.current?.contains(target)) ||
                isInsideDateFilterLayer(target)
            ) {
                return
            }

            closeFilter()
        }

        document.addEventListener("pointerdown", handlePointerDown)
        return () => document.removeEventListener("pointerdown", handlePointerDown)
    }, [closeFilter, filterOpen])

    const getMainSelectionChange = (nextMonths: number[], nextYears: number[]) => {
        const hasArbitraryPeriod = nextMonths.length > 0 || nextYears.length > 0
        const allTimeRange = earliestDate
            ? { startDate: startOfDay(earliestDate), endDate: endOfDay(new Date()) }
            : getPresetRange("all")

        return {
            nextRange: hasArbitraryPeriod ? null : allTimeRange,
            nextPreset: hasArbitraryPeriod ? "custom" as FilterPreset : "all" as FilterPreset,
        }
    }

    const handleSelectPreset = (preset: FilterPreset) => {
        if (preset === "custom") {
            setCalendarDraft(undefined)
            setCalendarOpen(true)
            setFilterOpen(true)
            return
        }
        let range = getPresetRange(preset)
        if (preset === "all" && earliestDate) {
            range = { startDate: startOfDay(earliestDate), endDate: endOfDay(new Date()) }
        }
        
        // When picking a classic preset, clear the array selections to avoid conflicts
        onChange({ range, preset, compare, compareRange, months: [], years: [], compareMonths, compareYears })
    }

    const [tempMonths, setTempMonths] = useState<number[]>(months)
    const [tempYears, setTempYears] = useState<number[]>(years)
    const [tempCompareMonths, setTempCompareMonths] = useState<number[]>(compareMonths)
    const [tempCompareYears, setTempCompareYears] = useState<number[]>(compareYears)

    useEffect(() => {
        setTempMonths(months)
    }, [months])

    useEffect(() => {
        setTempYears(years)
    }, [years])

    useEffect(() => {
        setTempCompareMonths(compareMonths)
    }, [compareMonths])

    useEffect(() => {
        setTempCompareYears(compareYears)
    }, [compareYears])

    const applyArraySelection = (type: 'months' | 'years' | 'compareMonths' | 'compareYears') => {
        const nextMonths = type === 'months' ? tempMonths : months
        const nextYears = type === 'years' ? tempYears : years
        const nextCompareMonths = type === 'compareMonths' ? tempCompareMonths : compareMonths
        const nextCompareYears = type === 'compareYears' ? tempCompareYears : compareYears

        if (type === 'compareMonths' || type === 'compareYears') {
            onChange({ range: value, preset: activePreset, compare, compareRange, months, years, compareMonths: nextCompareMonths, compareYears: nextCompareYears })
        } else {
            const { nextRange, nextPreset } = getMainSelectionChange(nextMonths, nextYears)
            onChange({ range: nextRange, preset: nextPreset, compare, compareRange, months: nextMonths, years: nextYears, compareMonths, compareYears })
        }

        setMonthsOpen(false)
        setYearsOpen(false)
        setCompareMonthsOpen(false)
        setCompareYearsOpen(false)
        setFilterOpen(false)
    }

    const toggleTempSelection = (type: 'months' | 'years' | 'compareMonths' | 'compareYears', val: number) => {
        const toggleValue = (current: number[]) => current.includes(val) ? current.filter(v => v !== val) : [...current, val]

        if (type === 'months') {
            const next = toggleValue(tempMonths)
            const { nextRange, nextPreset } = getMainSelectionChange(next, years)
            setTempMonths(next)
            onChange({ range: nextRange, preset: nextPreset, compare, compareRange, months: next, years, compareMonths, compareYears })
        } else if (type === 'years') {
            const next = toggleValue(tempYears)
            const { nextRange, nextPreset } = getMainSelectionChange(months, next)
            setTempYears(next)
            onChange({ range: nextRange, preset: nextPreset, compare, compareRange, months, years: next, compareMonths, compareYears })
        } else if (type === 'compareMonths') {
            const next = toggleValue(tempCompareMonths)
            setTempCompareMonths(next)
            onChange({ range: value, preset: activePreset, compare, compareRange, months, years, compareMonths: next, compareYears })
        } else if (type === 'compareYears') {
            const next = toggleValue(tempCompareYears)
            setTempCompareYears(next)
            onChange({ range: value, preset: activePreset, compare, compareRange, months, years, compareMonths, compareYears: next })
        }
    }

    const handleMainCalendarSelect = (range: CalendarRangeDraft) => {
        if (!range?.from) {
            setCalendarDraft(undefined)
            return
        }

        const hasPendingStart = Boolean(calendarDraft?.from && !calendarDraft.to)
        if (!hasPendingStart || !range.to) {
            setCalendarDraft({ from: range.from })
            return
        }

        setCalendarDraft(range)
        onChange({
            range: { startDate: startOfDay(range.from), endDate: endOfDay(range.to) },
            preset: "custom",
            compare,
            compareRange,
            months: [],
            years: [],
            compareMonths,
            compareYears,
        })
        closeFilter()
    }

    const handleCompareCalendarSelect = (range: CalendarRangeDraft) => {
        if (!range?.from) {
            setCompareCalendarDraft(undefined)
            return
        }

        const hasPendingStart = Boolean(compareCalendarDraft?.from && !compareCalendarDraft.to)
        if (!hasPendingStart || !range.to) {
            setCompareCalendarDraft({ from: range.from })
            return
        }

        const newCompareRange = { startDate: startOfDay(range.from), endDate: endOfDay(range.to) }
        setCompareCalendarDraft(range)
        onChange({ range: value, preset: activePreset, compare, compareRange: newCompareRange, months, years, compareMonths: [], compareYears: [] })
        closeFilter()
    }

    const selectedLabel = getPresetLabel(activePreset, value)

    const currentYear = new Date().getFullYear()
    const startYear = earliestDate ? earliestDate.getFullYear() : currentYear
    const dynamicYears = Array.from({ length: currentYear - startYear + 1 }, (_, i) => currentYear - i)

    if (customRangeOnly || hidePresets) {
        return (
            <div className={cn("flex items-center gap-2", className)}>
                <Popover open={calendarOpen} onOpenChange={handleCalendarOpenChange}>
                    <PopoverTrigger asChild>
                        <Button
                            variant="outline"
                            size="sm"
                            className={cn(
                                "h-10 px-4 border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm hover:bg-slate-50 dark:hover:bg-slate-800 transition-all rounded-xl gap-2.5 font-bold text-xs text-slate-700 dark:text-slate-300 min-w-[180px] justify-between",
                                activePreset === "custom" && value && "border-indigo-500/50 bg-indigo-50/10 text-indigo-600"
                            )}
                        >
                            <div className="flex items-center gap-2.5 truncate">
                                <CalendarIcon className="h-4 w-4 shrink-0 text-indigo-500" />
                                <span className="truncate">
                                    {value ? `${format(value.startDate, "dd MMM yyyy")} - ${format(value.endDate, "dd MMM yyyy")}` : "Custom Range"}
                                </span>
                            </div>
                            <ChevronDown className="h-3.5 w-3.5 opacity-50 shrink-0" />
                        </Button>
                    </PopoverTrigger>
                    <PopoverContent
                        data-global-date-filter-layer
                        className="w-auto p-0 rounded-3xl border-slate-200 dark:border-slate-800 shadow-[0_20px_50px_rgba(0,0,0,0.2)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.5)] overflow-visible"
                        align="start"
                        side="bottom"
                        sideOffset={8}
                        onInteractOutside={preventDropdownDismissForDateLayer}
                        onFocusOutside={preventDropdownDismissForDateLayer}
                        onOpenAutoFocus={(e) => e.preventDefault()}
                    >
                        <Calendar
                            autoFocus
                            mode="range"
                            defaultMonth={new Date()}
                            selected={calendarDraft}
                            onSelect={handleMainCalendarSelect}
                            numberOfMonths={2}
                            className="p-4 bg-white dark:bg-slate-900"
                        />
                    </PopoverContent>
                </Popover>
            </div>
        )
    }

    return (
        <div ref={filterRootRef} className={cn("relative flex items-center gap-2", className)}>
            <Button
                variant="outline"
                size="sm"
                type="button"
                aria-haspopup="dialog"
                aria-expanded={filterOpen}
                onClick={() => {
                    if (filterOpen) {
                        closeFilter()
                        return
                    }

                    setFilterOpen(true)
                }}
                className={cn(
                    "h-10 px-4 border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm hover:bg-slate-50 dark:hover:bg-slate-800 transition-all rounded-xl gap-2.5 font-bold text-xs text-slate-700 dark:text-slate-300 min-w-[140px] justify-between",
                    compare && "border-indigo-500/50 bg-indigo-50/10"
                )}
            >
                <div className="flex items-center gap-2.5 truncate">
                    <CalendarIcon className={cn("h-4 w-4 shrink-0", compare ? "text-indigo-600" : "text-indigo-500")} />
                    <span className="truncate">{selectedLabel}{compare && " (vs Prev)"}</span>
                </div>
                <ChevronDown className="h-3.5 w-3.5 opacity-50 shrink-0" />
            </Button>
            {filterOpen && (
                <dialog
                    open
                    data-global-date-filter-layer
                    className={cn(
                        "absolute left-0 top-full z-[80] mt-2 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl bg-white/95 dark:bg-slate-900/95 backdrop-blur-md md:left-auto md:right-0",
                        calendarOpen ? "w-auto p-0 overflow-visible" : "w-60 p-1.5"
                    )}
                >
                    {(() => {
                      if (calendarOpen) {
                        return (
                        <div data-global-date-filter-layer>
                            <Calendar
                                autoFocus
                                mode="range"
                                defaultMonth={new Date()}
                                selected={calendarDraft}
                                onSelect={handleMainCalendarSelect}
                                numberOfMonths={2}
                                className="p-4 bg-white dark:bg-slate-900"
                            />
                        </div>
                    )
                      }
                      return (
                        <>
                    <div className="px-2 py-1.5 mb-1 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        <span>Date Range</span>
                    </div>
                    {presets.map((p) => (
                        <button
                            type="button"
                            key={p.id}
                            onClick={() => handleSelectPreset(p.id)}
                            className={cn(
                                "w-full rounded-xl px-3 py-2 text-left text-xs font-semibold cursor-pointer flex items-center justify-between mb-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                                activePreset === p.id
                                    ? "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400"
                                    : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                            )}
                        >
                            {p.label}
                            {activePreset === p.id && <Check className="h-3.5 w-3.5" />}
                        </button>
                    ))}

                    <div className="px-2 py-2 mt-2 border-t border-slate-100 dark:border-slate-800 mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        Select Arbitrary Period
                    </div>
                    
                    {/* Advanced Multi-Select Arrays */}
                    <div className="grid grid-cols-2 gap-2 px-1 mb-2">
                        <Popover open={monthsOpen} onOpenChange={setMonthsOpen}>
                            <PopoverTrigger asChild>
                                <Button variant="outline" size="sm" className={cn("text-[10px] w-full gap-1 h-7 border-slate-200 dark:border-slate-800", months.length > 0 && "bg-indigo-50 border-indigo-200 text-indigo-700")}>
                                    <CalendarIcon className="w-3 h-3 opacity-60" /> {months.length > 0 ? `${months.length} Months` : 'Months'}
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent 
                                data-global-date-filter-layer
                                className="w-48 max-h-[var(--radix-popover-content-available-height)] overflow-hidden p-2 rounded-2xl shadow-xl border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
                                align="start"
                                side="bottom"
                                sideOffset={8}
                                collisionPadding={12}
                                onOpenAutoFocus={(e) => e.preventDefault()}
                            >
                                <div className="space-y-1 max-h-[calc(var(--radix-popover-content-available-height)-3.5rem)] overflow-y-auto pr-1">
                                    {monthPresets.map((m, i) => {
                                        const monthValue = i + 1
                                        return (
                                        <button
                                            type="button"
                                            key={m.id} 
                                            className={cn(
                                                "flex w-full items-center justify-between px-2 py-1.5 rounded-lg text-left text-xs cursor-pointer transition-colors",
                                                tempMonths.includes(monthValue) ? "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400" : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                                            )}
                                            onClick={() => toggleTempSelection('months', monthValue)}
                                        >
                                            {m.label}
                                            {tempMonths.includes(monthValue) && <Check className="h-3.5 w-3.5" />}
                                        </button>
                                        )
                                    })}
                                </div>
                                <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                                    <Button 
                                        size="sm" 
                                        onClick={() => applyArraySelection('months')}
                                        className="w-full h-8 text-[11px] font-bold bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl"
                                    >
                                        OK
                                    </Button>
                                </div>
                            </PopoverContent>
                        </Popover>

                        <Popover open={yearsOpen} onOpenChange={setYearsOpen}>
                            <PopoverTrigger asChild>
                                <Button variant="outline" size="sm" className={cn("text-[10px] w-full gap-1 h-7 border-slate-200 dark:border-slate-800", years.length > 0 && "bg-indigo-50 border-indigo-200 text-indigo-700")}>
                                    <Calculator className="w-3 h-3 opacity-60" /> {years.length > 0 ? `${years.length} Years` : 'Years'}
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent 
                                data-global-date-filter-layer
                                className="w-32 max-h-[var(--radix-popover-content-available-height)] overflow-hidden p-2 rounded-2xl shadow-xl border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
                                align="start"
                                side="bottom"
                                sideOffset={8}
                                collisionPadding={12}
                                onOpenAutoFocus={(e) => e.preventDefault()}
                            >
                                <div className="space-y-1 max-h-[calc(var(--radix-popover-content-available-height)-3.5rem)] overflow-y-auto pr-1">
                                    {dynamicYears.map((y: number) => (
                                        <button
                                            type="button"
                                            key={y} 
                                            className={cn(
                                                "flex w-full items-center justify-between px-2 py-1.5 rounded-lg text-left text-xs cursor-pointer transition-colors",
                                                tempYears.includes(y) ? "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400" : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                                            )}
                                            onClick={() => toggleTempSelection('years', y)}
                                        >
                                            {y}
                                            {tempYears.includes(y) && <Check className="h-3.5 w-3.5" />}
                                        </button>
                                    ))}
                                </div>
                                <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                                    <Button 
                                        size="sm" 
                                        onClick={() => applyArraySelection('years')}
                                        className="w-full h-8 text-[11px] font-bold bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl"
                                    >
                                        OK
                                    </Button>
                                </div>
                            </PopoverContent>
                        </Popover>
                    </div>

                    <div className="my-1.5 h-px bg-slate-100 dark:bg-slate-800" />

                    <div className="px-1 mb-1.5">
                        {/* <div className={cn(
                            "flex items-center justify-between p-2 rounded-xl transition-colors",
                            compare ? "bg-indigo-50/50 dark:bg-indigo-950/30" : "hover:bg-slate-50 dark:hover:bg-slate-800/50"
                        )}>
                            <div className="flex items-center gap-2">
                                <ArrowRightLeft className={cn("w-3.5 h-3.5", compare ? "text-indigo-600" : "text-slate-400")} />
                                <span className={cn("text-[11px] font-bold", compare ? "text-indigo-600" : "text-slate-600")}>Compare To</span>
                            </div>
                            <Switch
                                checked={compare}
                                onCheckedChange={toggleCompare}
                                className="scale-75 data-[state=checked]:bg-indigo-600"
                            />
                        </div> */}
                        {compare && (
                            <div className="mt-2 text-center">
                                <Popover open={compareCalendarOpen} onOpenChange={handleCompareCalendarOpenChange}>
                                    <PopoverTrigger asChild>
                                        <Button variant="outline" size="sm" className="w-full h-8 text-[11px] justify-start px-2.5 font-semibold text-slate-600 dark:text-slate-400 border-indigo-200 dark:border-indigo-800/60 bg-indigo-50/50 hover:bg-indigo-100/50 hover:text-indigo-600">
                                            <CalendarIcon className="mr-2 h-3.5 w-3.5 opacity-60" />
                                            {(() => {
                                              if (compareRange) {
                                                return `${format(compareRange.startDate, "dd MMM yyyy")} – ${format(compareRange.endDate, "dd MMM yyyy")}`
                                              }
                                              if ((compareMonths.length > 0 || compareYears.length > 0)) {
                                                return "Complex Comparison Array"
                                              }
                                              return "Previous Period (Auto)"
                                            })()}
                                        </Button>
                                    </PopoverTrigger>
                                    <PopoverContent
                                        data-global-date-filter-layer
                                        className="w-auto p-0 rounded-3xl border-slate-200 dark:border-slate-800 shadow-2xl overflow-visible z-[100]"
                                        align="center"
                                        side="bottom"
                                        sideOffset={8}
                                        onInteractOutside={(e) => e.preventDefault()}
                                        onFocusOutside={preventDropdownDismissForDateLayer}
                                        onOpenAutoFocus={(e) => e.preventDefault()}
                                    >
                                        <div>
                                            <div className="px-4 pt-3 pb-1 border-b border-slate-100 dark:border-slate-800">
                                                <p className="text-xs font-bold text-slate-500 uppercase tracking-wider text-center">Compare Period B Range</p>
                                            </div>
                                            
                                            <div className="p-3 bg-slate-50/50 dark:bg-slate-900 grid grid-cols-2 gap-2 border-b border-slate-100 dark:border-slate-800">
                                                <Popover open={compareMonthsOpen} onOpenChange={setCompareMonthsOpen}>
                                                    <PopoverTrigger asChild>
                                                        <Button variant="outline" size="sm" className={cn("text-[10px] w-full gap-1 h-7 border-slate-200 dark:border-slate-800", compareMonths.length > 0 && "bg-rose-50 border-rose-200 text-rose-700")}>
                                                            <CalendarIcon className="w-3 h-3 opacity-60" /> {compareMonths.length > 0 ? `${compareMonths.length} Months` : 'Months'}
                                                        </Button>
                                                    </PopoverTrigger>
                                                    <PopoverContent 
                                                        data-global-date-filter-layer
                                                        className="w-48 max-h-[var(--radix-popover-content-available-height)] overflow-hidden p-2 rounded-2xl shadow-xl border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
                                                        align="start"
                                                        side="bottom"
                                                        sideOffset={8}
                                                        collisionPadding={12}
                                                        onOpenAutoFocus={(e) => e.preventDefault()}
                                                    >
                                                        <div className="space-y-1 max-h-[calc(var(--radix-popover-content-available-height)-3.5rem)] overflow-y-auto pr-1">
                                                            {monthPresets.map((m, i) => {
                                                                const monthValue = i + 1
                                                                return (
                                                                <button
                                                                    type="button"
                                                                    key={m.id} 
                                                                    className={cn(
                                                                        "flex w-full items-center justify-between px-2 py-1.5 rounded-lg text-left text-xs cursor-pointer transition-colors",
                                                                        tempCompareMonths.includes(monthValue) ? "bg-rose-50 dark:bg-rose-900/40 text-rose-600 dark:text-rose-400" : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                                                                    )}
                                                                    onClick={() => toggleTempSelection('compareMonths', monthValue)}
                                                                >
                                                                    {m.label}
                                                                    {tempCompareMonths.includes(monthValue) && <Check className="h-3.5 w-3.5" />}
                                                                </button>
                                                                )
                                                            })}
                                                        </div>
                                                        <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                                                            <Button 
                                                                size="sm" 
                                                                onClick={() => applyArraySelection('compareMonths')}
                                                                className="w-full h-8 text-[11px] font-bold bg-rose-600 hover:bg-rose-700 text-white rounded-xl"
                                                            >
                                                                OK
                                                            </Button>
                                                        </div>
                                                    </PopoverContent>
                                                </Popover>

                                                <Popover open={compareYearsOpen} onOpenChange={setCompareYearsOpen}>
                                                    <PopoverTrigger asChild>
                                                        <Button variant="outline" size="sm" className={cn("text-[10px] w-full gap-1 h-7 border-slate-200 dark:border-slate-800", compareYears.length > 0 && "bg-rose-50 border-rose-200 text-rose-700")}>
                                                            <Calculator className="w-3 h-3 opacity-60" /> {compareYears.length > 0 ? `${compareYears.length} Years` : 'Years'}
                                                        </Button>
                                                    </PopoverTrigger>
                                                    <PopoverContent 
                                                        data-global-date-filter-layer
                                                        className="w-32 max-h-[var(--radix-popover-content-available-height)] overflow-hidden p-2 rounded-2xl shadow-xl border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
                                                        align="start"
                                                        side="bottom"
                                                        sideOffset={8}
                                                        collisionPadding={12}
                                                        onOpenAutoFocus={(e) => e.preventDefault()}
                                                    >
                                                        <div className="space-y-1 max-h-[calc(var(--radix-popover-content-available-height)-3.5rem)] overflow-y-auto pr-1">
                                                            {dynamicYears.map((y) => (
                                                                <button
                                                                    type="button"
                                                                    key={y} 
                                                                    className={cn(
                                                                        "flex w-full items-center justify-between px-2 py-1.5 rounded-lg text-left text-xs cursor-pointer transition-colors",
                                                                        tempCompareYears.includes(y) ? "bg-rose-50 dark:bg-rose-900/40 text-rose-600 dark:text-rose-400" : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                                                                    )}
                                                                    onClick={() => toggleTempSelection('compareYears', y)}
                                                                >
                                                                    {y}
                                                                    {tempCompareYears.includes(y) && <Check className="h-3.5 w-3.5" />}
                                                                </button>
                                                            ))}
                                                        </div>
                                                        <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                                                            <Button 
                                                                size="sm" 
                                                                onClick={() => applyArraySelection('compareYears')}
                                                                className="w-full h-8 text-[11px] font-bold bg-rose-600 hover:bg-rose-700 text-white rounded-xl"
                                                            >
                                                                OK
                                                            </Button>
                                                        </div>
                                                    </PopoverContent>
                                                </Popover>
                                            </div>

                                            <Calendar
                                                autoFocus
                                                mode="range"
                                                defaultMonth={compareRange?.startDate || value?.startDate || new Date()}
                                                selected={compareCalendarDraft}
                                                onSelect={handleCompareCalendarSelect}
                                                numberOfMonths={2}
                                                className="p-4 bg-white dark:bg-slate-900"
                                            />
                                            {compareRange && (
                                                <div className="p-2 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 flex justify-center">
                                                    <Button 
                                                        variant="ghost" 
                                                        size="sm" 
                                                        className="h-8 text-[11px] text-rose-500 hover:text-rose-600 hover:bg-rose-50 w-full"
                                                        onClick={() => {
                                                            onChange({ range: value, preset: activePreset, compare, compareRange: undefined, months, years, compareMonths, compareYears });
                                                            closeFilter();
                                                        }}
                                                    >
                                                        Clear & Use Default Previous
                                                    </Button>
                                                </div>
                                            )}
                                        </div>
                                    </PopoverContent>
                                </Popover>
                            </div>
                        )}
                    </div>

                    <div className="my-1.5 h-px bg-slate-100 dark:bg-slate-800" />

                    <button
                        type="button"
                        onClick={(event) => openMainCalendarFromMenu(event.nativeEvent)}
                        className={cn(
                            "w-full rounded-xl px-3 py-2 text-left text-xs font-semibold cursor-pointer flex items-center gap-2.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                            activePreset === "custom"
                                ? "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400"
                                : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                        )}
                    >
                        <CalendarIcon className="h-4 w-4 text-indigo-500" />
                        Custom Range...
                    </button>
                        </>
                    )
                    })()}
                </dialog>
            )}
        </div>
    )
}
