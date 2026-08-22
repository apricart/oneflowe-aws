"use client"

import { useState,useEffect,useCallback } from "react"
import { Columns3 } from "lucide-react"
import { Popover,PopoverContent,PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface ColumnDef {
    key: string
    label: string
    defaultVisible?: boolean
}

interface ColumnSelectorProps {
    columns: ColumnDef[]
    storageKey: string
    onChange: (visibleKeys: string[]) => void
    visibleKeys: string[]
}

/**
 * The persisted shape of a column preference.
 *
 * `known` records the columns that existed when the preference was written, so
 * a column added to a report later can be told apart from one the user chose to
 * hide. Without it a saved preference silently suppresses every new column for
 * everyone who had already opened the report once.
 */
type StoredColumnPreference = { visible: string[]; known: string[] }

const asKeyList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []

function readStoredPreference(storageKey: string): StoredColumnPreference | null {
    if (typeof window === "undefined") return null
    try {
        const saved = localStorage.getItem(`col-selector-${storageKey}`)
        if (!saved) return null
        const parsed = JSON.parse(saved)
        // Legacy payload: a bare array of visible keys. The column set it was
        // written against is unrecoverable, so the saved keys stand in for it
        // and anything absent counts as added since.
        if (Array.isArray(parsed)) {
            const visible = asKeyList(parsed)
            return { visible, known: visible }
        }
        if (parsed && typeof parsed === "object") {
            return { visible: asKeyList(parsed.visible), known: asKeyList(parsed.known) }
        }
    } catch { }
    return null
}

function resolveVisibleKeys(columns: ColumnDef[], storageKey: string): string[] {
    const defaultVisible = columns.filter(c => c.defaultVisible !== false).map(c => c.key)
    const stored = readStoredPreference(storageKey)
    if (!stored) return defaultVisible

    const validKeys = new Set(columns.map(c => c.key))
    const savedVisible = stored.visible.filter(key => validKeys.has(key))
    if (savedVisible.length === 0) return defaultVisible

    // A column the preference never saw has never been offered to this user, so
    // it takes its own default rather than being treated as deliberately hidden.
    const known = new Set(stored.known)
    const savedSet = new Set(savedVisible)
    const restored = columns
        .filter(c => !known.has(c.key) && c.defaultVisible !== false && !savedSet.has(c.key))
        .map(c => c.key)

    return restored.length > 0 ? [...savedVisible, ...restored] : savedVisible
}

export function useColumnSelector(columns: ColumnDef[], storageKey: string) {
    const defaultVisible = columns.filter(c => c.defaultVisible !== false).map(c => c.key)
    // Joined rather than compared by identity so the persistence effect below
    // does not re-run on every render for callers that inline their column list.
    const knownSignature = columns.map(c => c.key).join(",")

    const [visibleKeys, setVisibleKeys] = useState<string[]>(() => resolveVisibleKeys(columns, storageKey))

    useEffect(() => {
        try {
            localStorage.setItem(
                `col-selector-${storageKey}`,
                JSON.stringify({ visible: visibleKeys, known: knownSignature.split(",").filter(Boolean) }),
            )
        } catch { }
    }, [visibleKeys, storageKey, knownSignature])

    const toggleColumn = useCallback((key: string) => {
        setVisibleKeys(prev => {
            if (prev.includes(key)) {
                if (prev.length <= 2) return prev // Minimum 2 columns
                return prev.filter(k => k !== key)
            }
            return [...prev, key]
        })
    }, [])

    const resetToDefaults = useCallback(() => {
        setVisibleKeys(defaultVisible)
    }, [defaultVisible])

    const isVisible = useCallback((key: string) => visibleKeys.includes(key), [visibleKeys])

    return { visibleKeys, toggleColumn, resetToDefaults, isVisible, setVisibleKeys }
}

export function ColumnSelector({ columns, storageKey, onChange, visibleKeys }: Readonly<ColumnSelectorProps>) {
    const [open, setOpen] = useState(false)

    const defaultVisible = columns.filter(c => c.defaultVisible !== false).map(c => c.key)

    const handleToggle = (key: string) => {
        const isActive = visibleKeys.includes(key)
        if (isActive && visibleKeys.length <= 2) return // Minimum 2 columns

        const newKeys = isActive
            ? visibleKeys.filter(k => k !== key)
            : [...visibleKeys, key]
        onChange(newKeys)
    }

    const handleReset = () => {
        onChange(defaultVisible)
    }

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-2 text-xs font-semibold border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                    <Columns3 className="h-3.5 w-3.5 text-slate-400" />
                    Columns
                    <span className="text-[10px] font-bold text-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 px-1.5 py-0.5 rounded-md">
                        {visibleKeys.length}/{columns.length}
                    </span>
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0 border-slate-200 dark:border-slate-700 shadow-xl" align="end">
                <div className="p-3 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-700 dark:text-slate-300">Toggle Columns</span>
                        <button type="button"
                            onClick={handleReset}
                            className="text-[10px] font-bold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 uppercase tracking-wider"
                        >
                            Reset
                        </button>
                    </div>
                </div>
                <div className="max-h-[320px] overflow-y-auto p-1">
                    {columns.map((col) => {
                        const isActive = visibleKeys.includes(col.key)
                        return (
                            <label
                                key={col.key}
                                className={cn(
                                    "w-full flex items-center gap-3 px-3 py-2 rounded-md text-xs font-medium transition-colors cursor-pointer",
                                    isActive
                                        ? "text-slate-700 dark:text-slate-200 bg-indigo-50/50 dark:bg-indigo-900/10"
                                        : "text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                                )}
                            >
                                <input
                                    type="checkbox"
                                    checked={isActive}
                                    onChange={() => handleToggle(col.key)}
                                    className="h-4 w-4 rounded border-slate-300 accent-indigo-600 dark:border-slate-600"
                                />
                                <span className="truncate">{col.label}</span>
                            </label>
                        )
                    })}
                </div>
            </PopoverContent>
        </Popover>
    )
}
