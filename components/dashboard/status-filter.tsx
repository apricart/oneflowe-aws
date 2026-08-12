"use client"

import type { DashboardStatus } from "@/lib/hooks/use-sales-performance"

const options: { id: DashboardStatus; label: string; color: string; activeColor: string }[] = [
    { id: "all", label: "All Orders", color: "text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-400", activeColor: "bg-slate-700 text-white border-slate-700 shadow-md shadow-slate-200 dark:shadow-slate-900/40" },
    { id: "FULFILLED", label: "Fulfilled", color: "text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800 hover:border-emerald-400", activeColor: "bg-emerald-600 text-white border-emerald-700 shadow-md shadow-emerald-200 dark:shadow-emerald-900/40" },
    { id: "PENDING", label: "Pending Approval", color: "text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800 hover:border-amber-400", activeColor: "bg-amber-500 text-white border-amber-600 shadow-md shadow-amber-200 dark:shadow-amber-900/40" },
    { id: "REFUNDED", label: "Refunded", color: "text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800 hover:border-rose-400", activeColor: "bg-rose-600 text-white border-rose-700 shadow-md shadow-rose-200 dark:shadow-rose-900/40" },
]

interface StatusFilterProps {
    value: DashboardStatus
    onChange: (status: DashboardStatus) => void
}

export function StatusFilter({ value, onChange }: Readonly<StatusFilterProps>) {
    return (
        <div className="flex items-center gap-1.5 flex-wrap">
            {options.map(opt => (
                <button type="button"
                    key={opt.id}
                    onClick={() => onChange(opt.id)}
                    className={`
            px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all duration-200
            ${value === opt.id ? `${opt.activeColor} scale-105` : `bg-white dark:bg-slate-800 ${opt.color}`}
          `}
                >
                    {opt.label}
                </button>
            ))}
        </div>
    )
}
