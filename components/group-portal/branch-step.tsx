"use client"

import { useMemo, useState } from "react"
import { Building2, CheckCheck, MapPin, Search, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

import type { ScopedBranch } from "./types"

/**
 * Step 2 — choose the branches this batch of items is for.
 *
 * The selection is a plain multi-select over the group's branches. Whatever is
 * chosen here applies to every item picked in the next step, and the whole pair
 * becomes one entry the user can repeat as often as they like.
 */
export function BranchStep({
  branches,
  selectedBranchIds,
  coveredBranchIds,
  onChange,
}: Readonly<{
  branches: ScopedBranch[]
  selectedBranchIds: number[]
  coveredBranchIds: number[]
  onChange: (branchIds: number[]) => void
}>) {
  const [search, setSearch] = useState("")

  const selected = useMemo(() => new Set(selectedBranchIds), [selectedBranchIds])
  const covered = useMemo(() => new Set(coveredBranchIds), [coveredBranchIds])

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return branches
    return branches.filter((branch) =>
      branch.name.toLowerCase().includes(needle)
      || (branch.city ?? "").toLowerCase().includes(needle)
      || (branch.costCenterId ?? "").toLowerCase().includes(needle))
  }, [branches, search])

  const allVisibleSelected = visible.length > 0 && visible.every((branch) => selected.has(branch.id))

  const toggle = (branchId: number) => {
    onChange(selected.has(branchId)
      ? selectedBranchIds.filter((id) => id !== branchId)
      : [...selectedBranchIds, branchId])
  }

  const toggleAllVisible = () => {
    if (allVisibleSelected) {
      const visibleIds = new Set(visible.map((branch) => branch.id))
      onChange(selectedBranchIds.filter((id) => !visibleIds.has(id)))
      return
    }
    onChange([...new Set([...selectedBranchIds, ...visible.map((branch) => branch.id)])])
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Select locations
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            The items you pick next will be ordered for every branch selected here.
          </p>
        </div>
        <Badge variant={selectedBranchIds.length > 0 ? "default" : "secondary"} className="w-fit">
          {selectedBranchIds.length} selected
        </Badge>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search branches by name, city, or cost centre"
            className="pl-9"
            aria-label="Search branches"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear branch search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-600"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button type="button" variant="outline" onClick={toggleAllVisible} disabled={visible.length === 0} className="gap-2">
          <CheckCheck className="h-4 w-4" />
          {allVisibleSelected ? "Clear these" : "Select all"}
        </Button>
      </div>

      {visible.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="p-6 text-sm text-slate-500 dark:text-slate-400">
            No branches match “{search}”.
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((branch) => {
            const isSelected = selected.has(branch.id)
            return (
              <li key={branch.id}>
                <label
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition",
                    isSelected
                      ? "border-indigo-500 bg-indigo-50/60 dark:border-indigo-500 dark:bg-indigo-950/30"
                      : "border-slate-200 bg-white hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-900",
                  )}
                >
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggle(branch.id)}
                    aria-label={`Select ${branch.name}`}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      <Building2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      {branch.name}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                      {branch.city && (
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {branch.city}
                        </span>
                      )}
                      {branch.costCenterId && <span>CC {branch.costCenterId}</span>}
                      {/* Already covered by an earlier entry — selecting it again adds to that same order. */}
                      {covered.has(branch.id) && (
                        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                          already in this order
                        </Badge>
                      )}
                    </span>
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
