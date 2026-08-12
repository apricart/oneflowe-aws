"use client"

import * as React from "react"
import * as Select from "@radix-ui/react-select"
import { ChevronDownIcon, CheckIcon, Calendar } from "lucide-react"

interface YearPickerProps {
    selectedYear: string
    onYearChange: (year: string) => void
}

export function YearPicker({
    selectedYear,
    onYearChange,
}: Readonly<YearPickerProps>) {
    const currentYear = new Date().getFullYear()
    // Generate years from 2022 to current year + 1
    const years = React.useMemo(() => {
        const startYear = 2022
        const endYear = currentYear + 1
        const yearsList = []
        for (let y = startYear; y <= endYear; y++) {
            yearsList.push(y.toString())
        }
        return yearsList.reverse() // Newest first
    }, [currentYear])

    return (
        <Select.Root value={selectedYear} onValueChange={onYearChange}>
            <Select.Trigger className="inline-flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 transition-colors min-w-[100px]">
                <div className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-slate-500 dark:text-slate-400" />
                    <Select.Value className="text-slate-900 dark:text-slate-100" />
                </div>
                <Select.Icon>
                    <ChevronDownIcon className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400 opacity-50" />
                </Select.Icon>
            </Select.Trigger>

            <Select.Portal>
                <Select.Content
                    className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg dark:shadow-slate-900/50 z-[100] overflow-hidden min-w-[120px]"
                    position="popper"
                    sideOffset={4}
                >
                    <Select.Viewport className="p-1">
                        {years.map((y) => (
                            <Select.Item
                                key={y}
                                value={y}
                                className="relative flex items-center px-8 py-2 text-sm rounded-md cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700/50 focus:bg-slate-100 dark:focus:bg-slate-700/50 outline-none select-none data-[state=checked]:font-semibold data-[state=checked]:text-blue-600 dark:data-[state=checked]:text-blue-400"
                            >
                                <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                                    <CheckIcon className="h-3.5 w-3.5" />
                                </Select.ItemIndicator>
                                <Select.ItemText>{y}</Select.ItemText>
                            </Select.Item>
                        ))}
                    </Select.Viewport>
                </Select.Content>
            </Select.Portal>
        </Select.Root>
    )
}
