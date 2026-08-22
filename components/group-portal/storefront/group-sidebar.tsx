"use client"

import { Building2, Check, ChevronDown, ChevronRight, Layers, MapPin } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ListSkeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

import type { ScopedBranch, ScopedGroup } from "../types"

/**
 * A stable DOM-safe key for a group. The ungrouped bucket carries no id, so it
 * cannot share the numeric namespace with a real group.
 */
export function groupKey(groupId: number | null): string {
  return groupId === null ? "ungrouped" : String(groupId)
}

/**
 * The storefront's navigation: the groups this user was assigned, and the
 * locations inside them.
 *
 * Any group can be opened to see what is in it — looking is never destructive.
 * Ticking a location is the commitment, and locations belong to one group at a
 * time: the server accepts a single group per submission, so ticking a location
 * in another group moves the selection there and clears the previous group
 * automatically. That is why a group that is not the selected one always draws
 * its locations unticked, however it was reached.
 *
 * Losing a cart is a separate matter and is escalated to the caller, which asks
 * before discarding one.
 */
export function GroupSidebar({
  groups,
  loading,
  failed,
  selectedGroupId,
  selectedBranchIds,
  expandedGroupKey,
  disabled = false,
  onToggleExpand,
  onToggleBranch,
  onSetGroupBranches,
}: Readonly<{
  groups: ScopedGroup[]
  loading: boolean
  failed: boolean
  selectedGroupId: number | null | undefined
  selectedBranchIds: number[]
  expandedGroupKey: string | null
  disabled?: boolean
  onToggleExpand: (key: string) => void
  onToggleBranch: (groupId: number | null, branchId: number) => void
  onSetGroupBranches: (groupId: number | null, branchIds: number[]) => void
}>) {
  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <ListSkeleton rows={5} />
      </div>
    )
  }

  if (failed) {
    return (
      <div
        role="alert"
        className="rounded-2xl border border-rose-200 bg-rose-50/60 p-4 text-sm text-slate-700 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-slate-300"
      >
        Your assigned groups could not be loaded. Please try again, or contact your administrator
        if this continues.
      </div>
    )
  }

  if (groups.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        No groups are assigned to your account yet. Ask your administrator to assign a group or a
        branch so you can start ordering.
      </div>
    )
  }

  return (
    <nav
      aria-label="Groups and locations"
      className="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <p className="flex items-center gap-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <Layers className="h-3.5 w-3.5" />
        Your groups
      </p>

      {groups.length > 1 && (
        <p className="px-3 pb-2 text-[11px] leading-snug text-slate-400 dark:text-slate-500">
          Order for one group at a time. Picking a location in another group moves your selection
          there.
        </p>
      )}

      <ul className="space-y-1">
        {groups.map((group) => (
          <li key={groupKey(group.id)}>
            <GroupRow
              group={group}
              active={group.id === selectedGroupId}
              expanded={expandedGroupKey === groupKey(group.id)}
              selectedBranchIds={selectedBranchIds}
              disabled={disabled}
              onToggleExpand={onToggleExpand}
              onToggleBranch={onToggleBranch}
              onSetGroupBranches={onSetGroupBranches}
            />
          </li>
        ))}
      </ul>
    </nav>
  )
}

/** One group: a disclosure header, and its locations when opened. */
function GroupRow({
  group,
  active,
  expanded,
  selectedBranchIds,
  disabled,
  onToggleExpand,
  onToggleBranch,
  onSetGroupBranches,
}: Readonly<{
  group: ScopedGroup
  active: boolean
  expanded: boolean
  selectedBranchIds: number[]
  disabled: boolean
  onToggleExpand: (key: string) => void
  onToggleBranch: (groupId: number | null, branchId: number) => void
  onSetGroupBranches: (groupId: number | null, branchIds: number[]) => void
}>) {
  const key = groupKey(group.id)
  const panelId = `group-branches-${key}`
  // A group that is not the selected one has no locations ticked, whatever the
  // selection state happens to hold. One group at a time, shown as well as enforced.
  const tickedIds = active ? selectedBranchIds : []
  const tickedCount = group.branches.filter((branch) => tickedIds.includes(branch.id)).length
  const allTicked = tickedCount > 0 && tickedCount === group.branches.length

  return (
    <>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        disabled={disabled}
        onClick={() => onToggleExpand(key)}
        className={cn(
          "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition",
          "disabled:cursor-not-allowed disabled:opacity-60",
          active
            ? "bg-[color:var(--color-brand-primary)] font-semibold text-white shadow-sm"
            : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
        )}
      >
        {expanded
          ? <ChevronDown className="h-4 w-4 shrink-0" />
          : <ChevronRight className={cn("h-4 w-4 shrink-0", !active && "text-slate-400")} />}
        <span className="min-w-0 flex-1 truncate" title={group.name}>{group.name}</span>
        {active && <Check className="h-3.5 w-3.5 shrink-0" aria-label="Ordering for this group" />}
        <Badge
          variant={active ? "secondary" : "outline"}
          className={cn("shrink-0 text-[10px]", active && "bg-white/20 text-white")}
        >
          {active ? `${tickedCount}/${group.branches.length}` : group.branches.length}
        </Badge>
      </button>

      {expanded && (
        <div id={panelId} className="mt-1 space-y-1 pb-2 pl-4">
          <div className="flex items-center justify-between gap-2 pl-2 pr-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Locations
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || group.branches.length === 0}
              className="h-6 px-2 text-[11px] font-medium text-[color:var(--color-brand-primary)]"
              onClick={() => onSetGroupBranches(
                group.id,
                allTicked ? [] : group.branches.map((branch) => branch.id),
              )}
            >
              {allTicked ? "Clear all" : "Select all"}
            </Button>
          </div>

          {group.branches.length === 0 ? (
            <p className="px-2 py-1 text-xs text-slate-500 dark:text-slate-400">
              This group has no branches you can order for.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {group.branches.map((branch) => (
                <li key={branch.id}>
                  <BranchRow
                    branch={branch}
                    checked={tickedIds.includes(branch.id)}
                    disabled={disabled}
                    onToggle={() => onToggleBranch(group.id, branch.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  )
}

function BranchRow({
  branch,
  checked,
  disabled,
  onToggle,
}: Readonly<{
  branch: ScopedBranch
  checked: boolean
  disabled: boolean
  onToggle: () => void
}>) {
  const inputId = `branch-${branch.id}`

  return (
    <label
      htmlFor={inputId}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition",
        disabled && "cursor-not-allowed opacity-60",
        checked
          ? "bg-slate-100 font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100"
          : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800/60",
      )}
    >
      <Checkbox
        id={inputId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onToggle}
        aria-label={`Order for ${branch.name}`}
      />
      <Building2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
      <span className="min-w-0 flex-1 truncate" title={branch.name}>{branch.name}</span>
      {branch.city && (
        <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-slate-400">
          <MapPin className="h-3 w-3" />
          {branch.city}
        </span>
      )}
    </label>
  )
}
