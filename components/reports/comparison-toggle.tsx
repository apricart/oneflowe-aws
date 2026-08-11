"use client"

import { Switch } from "@/components/ui/switch"
import { GitCompareArrows } from "lucide-react"
import { cn } from "@/lib/utils"

interface ComparisonToggleProps {
    enabled: boolean
    onToggle: (enabled: boolean) => void
    currentLabel?: string
    previousLabel?: string
}

export function ComparisonToggle({
    enabled,
    onToggle,
    currentLabel = "Current Period",
    previousLabel = "Previous Period",
}: Readonly<ComparisonToggleProps>) {
    return (
        <div className={cn(
            "inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border transition-all duration-200",
            enabled
                ? "bg-indigo-50 dark:bg-indigo-900/20 border-indigo-200 dark:border-indigo-800"
                : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700"
        )}>
            <GitCompareArrows className={cn(
                "h-3.5 w-3.5 transition-colors",
                enabled ? "text-indigo-600 dark:text-indigo-400" : "text-slate-400"
            )} />
            <span className={cn(
                "text-[11px] font-semibold transition-colors",
                enabled ? "text-indigo-700 dark:text-indigo-300" : "text-slate-500 dark:text-slate-400"
            )}>
                Compare
            </span>
            <Switch
                checked={enabled}
                onCheckedChange={onToggle}
                className="scale-75 data-[state=checked]:bg-indigo-600"
            />
            {enabled && (
                <span className="text-[10px] text-indigo-500 dark:text-indigo-400 font-medium animate-in fade-in duration-200">
                    {currentLabel} vs {previousLabel}
                </span>
            )}
        </div>
    )
}
