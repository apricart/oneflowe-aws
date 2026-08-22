"use client"

import { Building2, Layers } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

import type { ScopedGroup } from "./types"

/**
 * Step 1 — choose the group to order for.
 *
 * Every branch in a group shares the same catalogue, so scoping a submission to
 * one group is what makes a single product selection valid for all of its
 * branches. The workspace skips this step entirely when the user has only one
 * group.
 */
export function GroupStep({
  groups,
  selectedGroupId,
  onSelect,
}: Readonly<{
  groups: ScopedGroup[]
  selectedGroupId: number | null | undefined
  onSelect: (groupId: number | null) => void
}>) {
  if (groups.length === 0) {
    return (
      <Card className="rounded-2xl border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20">
        <CardContent className="p-6 text-sm text-slate-700 dark:text-slate-300">
          No branches are assigned to your account yet, so there is nothing to order for. Ask your
          administrator to assign a group or a branch to you.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Which group are you ordering for?
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          One group per order. Branches within a group share the same catalogue.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {groups.map((group) => {
          const isSelected = selectedGroupId === group.id
          return (
            <button
              key={group.id ?? "ungrouped"}
              type="button"
              onClick={() => onSelect(group.id)}
              aria-pressed={isSelected}
              className={cn(
                "rounded-2xl border p-4 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                isSelected
                  ? "border-indigo-500 bg-indigo-50/70 shadow-sm dark:border-indigo-500 dark:bg-indigo-950/30"
                  : "border-slate-200 bg-white hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-900",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
                  <Layers className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                  {group.name}
                </div>
                <Badge variant={isSelected ? "default" : "secondary"} className="shrink-0">
                  {group.branches.length}
                </Badge>
              </div>
              <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <Building2 className="h-3.5 w-3.5" />
                {group.branches.length === 1 ? "1 branch in scope" : `${group.branches.length} branches in scope`}
              </p>
            </button>
          )
        })}
      </div>
    </div>
  )
}
