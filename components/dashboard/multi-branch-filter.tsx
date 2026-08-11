"use client"

import React, { useState, useCallback, useMemo, useRef, useEffect } from "react"
import { Check, ChevronDown, GitBranch, X, Search } from "lucide-react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"

interface Branch {
    id: number
    name: string
    groupName?: string
}

interface MultiBranchFilterProps {
    organizationId?: string | null
    selectedBranchIds: string[]
    onChange: (ids: string[]) => void
}

export function MultiBranchFilter({ organizationId, selectedBranchIds, onChange }: Readonly<MultiBranchFilterProps>) {
    const [open, setOpen] = useState(false)
    const [searchQuery, setSearchQuery] = useState("")
    const dropdownRef = useRef<HTMLDivElement>(null)

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setOpen(false)
            }
        }

        if (open) {
            document.addEventListener('mousedown', handleClickOutside)
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside)
        }
    }, [open])

    const url = organizationId
        ? `/api/v1/branches?organizationId=${organizationId}&limit=100`
        : null

    const { data } = useSWR<{ items: Branch[] }>(url, fetcher, {
        revalidateOnFocus: false,
    })

    const branches = data?.items || []

    // Filter branches based on search query
    const filteredBranches = useMemo(() => {
        if (!searchQuery.trim()) return branches
        const query = searchQuery.toLowerCase()
        return branches.filter(branch => 
            branch.name.toLowerCase().includes(query) ||
            branch.id.toString().includes(query)
        )
    }, [branches, searchQuery])

    const toggle = useCallback((id: string) => {
        if (selectedBranchIds.includes(id)) {
            onChange(selectedBranchIds.filter(b => b !== id))
        } else {
            onChange([...selectedBranchIds, id])
        }
    }, [selectedBranchIds, onChange])

    const clearAll = useCallback(() => {
        onChange([])
    }, [onChange])

    const selectAll = useCallback(() => {
        onChange(filteredBranches.map(b => String(b.id)))
    }, [filteredBranches, onChange])

    const hasSelection = selectedBranchIds.length > 0
    const label = (() => {
      if (hasSelection) {
        if (selectedBranchIds.length === 1) {
          return branches.find(b => String(b.id) === selectedBranchIds[0])?.name || "1 Branch"
        }
        return `${selectedBranchIds.length} Branches`
      }
      return "All Branches"
    })()

    if (!organizationId || branches.length === 0) return null

    return (
        <div className="relative" ref={dropdownRef}>
            <button type="button"
                onClick={() => setOpen(prev => !prev)}
                className={`
          flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all duration-200
          ${hasSelection
                        ? "bg-indigo-600 text-white border-indigo-700 shadow-md shadow-indigo-200 dark:shadow-indigo-900/40"
                        : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-indigo-300 dark:hover:border-indigo-600 hover:text-indigo-600"
                    }
        `}
            >
                <GitBranch className="h-3 w-3" />
                <span>{label}</span>
                {(() => {
                  if (hasSelection) {
                    return (
                    <X
                        className="h-3 w-3 ml-0.5 opacity-80 hover:opacity-100"
                        onClick={(e: React.MouseEvent) => { e.stopPropagation(); clearAll() }}
                    />
                )
                  }
                  return (
                    <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
                )
                })()}
            </button>

            {open && (
                <div className="absolute top-full right-0 mt-2 z-[999] animate-in fade-in slide-in-from-top-2 duration-200 min-w-[280px]">
                    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-2xl overflow-hidden">
                        {/* Header */}
                        <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
                            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                                Branches
                            </span>
                            <div className="flex items-center gap-3">
                                <button type="button"
                                    onClick={selectAll} 
                                    className="text-xs font-bold text-indigo-600 hover:text-indigo-700 uppercase tracking-wider"
                                >
                                    All
                                </button>
                                <span className="text-slate-300">|</span>
                                <button type="button"
                                    onClick={clearAll} 
                                    className="text-xs font-bold text-rose-500 hover:text-rose-600 uppercase tracking-wider"
                                >
                                    None
                                </button>
                            </div>
                        </div>

                        {/* Search */}
                        <div className="px-4 py-3">
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
                                <input
                                    type="text"
                                    placeholder="Search..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="w-full pl-10 pr-3 py-2.5 text-sm border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                                />
                            </div>
                        </div>

                        {/* Branch List */}
                        <div className="max-h-60 overflow-y-auto px-2 pb-2">
                            {(() => {
                              if (filteredBranches.length === 0) {
                                return (
                                <div className="flex flex-col items-center justify-center py-8">
                                    <GitBranch className="h-8 w-8 text-slate-400" />
                                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">No branches found</p>
                                </div>
                            )
                              }
                              return (
                                <div className="space-y-1">
                                    {filteredBranches.map((branch) => (
                                        <div
                                            key={branch.id}
                                            role="checkbox"
                                            aria-checked={selectedBranchIds.includes(String(branch.id))}
                                            tabIndex={0}
                                            className="flex items-center gap-3 p-3 rounded-xl transition-all duration-200 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/50"
                                            onClick={() => toggle(String(branch.id))}
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter" || event.key === " ") {
                                                    event.preventDefault()
                                                    toggle(String(branch.id))
                                                }
                                            }}
                                        >
                                            {/* Checkbox */}
                                            <div className={`
                                                flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-all duration-200
                                                ${selectedBranchIds.includes(String(branch.id))
                                                    ? "bg-indigo-600 border-indigo-600"
                                                    : "border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700"
                                                }
                                            `}>
                                                {selectedBranchIds.includes(String(branch.id)) && (
                                                    <Check className="h-3 w-3 text-white" />
                                                )}
                                            </div>
                                            {/* Branch Name */}
                                            <span className={`
                                                text-sm font-medium flex-1
                                                ${selectedBranchIds.includes(String(branch.id))
                                                    ? "text-slate-900 dark:text-white"
                                                    : "text-slate-600 dark:text-slate-400"
                                                }
                                            `}>
                                                {branch.name}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )
                            })()}
                        </div>

                        {/* Apply Button */}
                        <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-700">
                            <button type="button"
                                onClick={() => setOpen(false)}
                                className="w-full py-3 rounded-xl bg-indigo-600 text-white text-xs font-bold uppercase tracking-wider hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-600/20"
                            >
                                Apply Selection ({selectedBranchIds.length})
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
