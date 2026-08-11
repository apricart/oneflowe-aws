"use client"

import { X } from "lucide-react"
import { cn } from "@/lib/utils"

export interface FilterTag {
    key: string
    label: string
    value: string
    icon?: React.ReactNode
    color?: "blue" | "indigo" | "emerald" | "rose" | "amber"
}

interface FilterTagBarProps {
    tags: FilterTag[]
    onRemove: (key: string) => void
    onClearAll?: () => void
    className?: string
}

const tagColors = {
    blue: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800",
    indigo: "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/20 dark:text-indigo-300 dark:border-indigo-800",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800",
    rose: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/20 dark:text-rose-300 dark:border-rose-800",
    amber: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800",
}

export function FilterTagBar({ tags, onRemove, onClearAll, className }: Readonly<FilterTagBarProps>) {
    if (tags.length === 0) return null

    return (
        <div className={cn("flex items-center gap-2 flex-wrap", className)}>
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500 shrink-0">
                Filters:
            </span>
            {tags.map((tag) => (
                <div
                    key={tag.key}
                    className={cn(
                        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition-all duration-200 hover:shadow-sm",
                        tagColors[tag.color || "blue"]
                    )}
                >
                    {tag.icon && <span className="opacity-60">{tag.icon}</span>}
                    <span className="opacity-60">{tag.label}:</span>
                    <span>{tag.value}</span>
                    <button type="button"
                        onClick={(e) => { e.stopPropagation(); onRemove(tag.key) }}
                        className="ml-0.5 hover:opacity-100 opacity-50 transition-opacity rounded-full p-0.5 hover:bg-black/5 dark:hover:bg-white/10"
                    >
                        <X className="h-2.5 w-2.5" />
                    </button>
                </div>
            ))}
            {tags.length > 1 && onClearAll && (
                <button type="button"
                    onClick={onClearAll}
                    className="text-[10px] font-bold text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 uppercase tracking-wider transition-colors"
                >
                    Clear All
                </button>
            )}
        </div>
    )
}
