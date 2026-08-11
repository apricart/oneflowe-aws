"use client"

import { useState,useEffect } from "react"
import { Calendar } from "lucide-react"
import { cn } from "@/lib/utils"

interface QuickDateRangeProps {
    startDate: string
    endDate: string
    onStartDateChange: (date: string) => void
    onEndDateChange: (date: string) => void
    storageKey?: string
}

type RangeKey = "today" | "7days" | "30days" | "thisMonth" | "thisQuarter" | "custom"

function getDateRange(key: RangeKey): { start: string; end: string } | null {
    const now = new Date()
    const fmt = (d: Date) => d.toISOString().split("T")[0]

    switch (key) {
        case "today":
            return { start: fmt(now), end: fmt(now) }
        case "7days": {
            const start = new Date(now)
            start.setDate(start.getDate() - 6)
            return { start: fmt(start), end: fmt(now) }
        }
        case "30days": {
            const start = new Date(now)
            start.setDate(start.getDate() - 29)
            return { start: fmt(start), end: fmt(now) }
        }
        case "thisMonth":
            return { start: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), end: fmt(now) }
        case "thisQuarter": {
            const q = Math.floor(now.getMonth() / 3)
            return { start: fmt(new Date(now.getFullYear(), q * 3, 1)), end: fmt(now) }
        }
        default:
            return null
    }
}

const ranges: { key: RangeKey; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "7days", label: "7 Days" },
    { key: "30days", label: "30 Days" },
    { key: "thisMonth", label: "This Month" },
    { key: "thisQuarter", label: "Quarter" },
    { key: "custom", label: "Custom" },
]

function restoreDateRange(options: {
    storageKey: string
    setActiveRange: (range: RangeKey) => void
    setShowCustom: (show: boolean) => void
    onStartDateChange: (date: string) => void
    onEndDateChange: (date: string) => void
}): void {
    const { storageKey, setActiveRange, setShowCustom, onStartDateChange, onEndDateChange } = options
    try {
        const saved = localStorage.getItem(storageKey)
        if (!saved) return
        const parsed = JSON.parse(saved)
        if (!parsed.activeRange) return
        setActiveRange(parsed.activeRange)
        if (parsed.activeRange === "custom") {
            setShowCustom(true)
            if (parsed.startDate) onStartDateChange(parsed.startDate)
            if (parsed.endDate) onEndDateChange(parsed.endDate)
            return
        }
        const range = getDateRange(parsed.activeRange)
        if (range) {
            onStartDateChange(range.start)
            onEndDateChange(range.end)
        }
    } catch (error) {
        console.warn("Unable to restore the saved report date range:", error)
    }
}

export function QuickDateRange({
    startDate,
    endDate,
    onStartDateChange,
    onEndDateChange,
    storageKey = "report-date-range",
}: Readonly<QuickDateRangeProps>) {
    const [activeRange, setActiveRange] = useState<RangeKey>("thisMonth")
    const [showCustom, setShowCustom] = useState(false)

    // Restore from localStorage on mount
    useEffect(() => {
        restoreDateRange({ storageKey, setActiveRange, setShowCustom, onStartDateChange, onEndDateChange })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const handleRangeClick = (key: RangeKey) => {
        setActiveRange(key)
        if (key === "custom") {
            setShowCustom(true)
            localStorage.setItem(storageKey, JSON.stringify({ activeRange: key, startDate, endDate }))
            return
        }
        setShowCustom(false)
        const range = getDateRange(key)
        if (range) {
            onStartDateChange(range.start)
            onEndDateChange(range.end)
            localStorage.setItem(storageKey, JSON.stringify({ activeRange: key }))
        }
    }

    const handleCustomDateChange = (type: "start" | "end", value: string) => {
        if (type === "start") onStartDateChange(value)
        else onEndDateChange(value)
        localStorage.setItem(
            storageKey,
            JSON.stringify({
                activeRange: "custom",
                startDate: type === "start" ? value : startDate,
                endDate: type === "end" ? value : endDate,
            })
        )
    }

    return (
        <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/50">
                <Calendar className="h-3.5 w-3.5 ml-2 text-slate-400" />
                {ranges.map(({ key, label }) => (
                    <button type="button"
                        key={key}
                        onClick={() => handleRangeClick(key)}
                        className={cn(
                            "px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200",
                            activeRange === key
                                ? "bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm ring-1 ring-slate-200 dark:ring-slate-600"
                                : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-white/50 dark:hover:bg-slate-700/50"
                        )}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {showCustom && (
                <div className="flex items-center gap-2 animate-in fade-in slide-in-from-left-2 duration-200">
                    <input
                        type="date"
                        value={startDate}
                        onChange={(e) => handleCustomDateChange("start", e.target.value)}
                        className="h-8 px-2 rounded-lg text-xs border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                    />
                    <span className="text-xs text-slate-400 font-medium">to</span>
                    <input
                        type="date"
                        value={endDate}
                        onChange={(e) => handleCustomDateChange("end", e.target.value)}
                        className="h-8 px-2 rounded-lg text-xs border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                    />
                </div>
            )}
        </div>
    )
}
