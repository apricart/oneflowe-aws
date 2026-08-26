"use client"

import { useMemo, useState } from "react"
import { Building2, Check, ChevronDown, ChevronRight, Layers, MapPin, Search, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ListSkeleton } from "@/components/ui/skeleton"
import { budgetRemainingRatio } from "@/lib/branch-budget-summary"
import { cn, formatPKR } from "@/lib/utils"

import type { BranchBudgetSummary, ScopedBranch, ScopedGroup } from "../types"
import { MAX_LOCATION_MATCHES, searchLocations, type LocationSearchResult } from "./location-search"

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
 *
 * The search box finds a location across every assigned group, for the common
 * case of knowing the branch but not which group holds it. It only changes how
 * a location is *reached*: results stay grouped, a result outside the group
 * being ordered for still draws unticked, and ticking one runs the same move as
 * ticking it in the tree would. Searching can therefore never assemble a
 * selection spanning two groups.
 */
export function GroupSidebar({
  groups,
  loading,
  failed,
  selectedGroupId,
  selectedBranchIds,
  expandedGroupKey,
  budgets,
  budgetsLoading = false,
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
  /**
   * This month's budget per branch id. A location missing from the map simply
   * shows no figure — the budget is an aid to the requester, never a gate, so
   * an unavailable one must not hide a location or block ordering for it.
   */
  budgets?: ReadonlyMap<number, BranchBudgetSummary>
  budgetsLoading?: boolean
  disabled?: boolean
  onToggleExpand: (key: string) => void
  onToggleBranch: (groupId: number | null, branchId: number) => void
  onSetGroupBranches: (groupId: number | null, branchIds: number[]) => void
}>) {
  const [query, setQuery] = useState("")
  const results = useMemo(() => searchLocations(groups, query), [groups, query])
  const searching = query.trim().length > 0

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

      <LocationSearchBox query={query} disabled={disabled} onChange={setQuery} />

      {groups.length > 1 && !searching && (
        <p className="px-3 pb-2 text-[11px] leading-snug text-slate-400 dark:text-slate-500">
          Order for one group at a time. Picking a location in another group moves your selection
          there.
        </p>
      )}

      {searching ? (
        <LocationSearchResults
          query={query}
          results={results}
          selectedGroupId={selectedGroupId}
          selectedBranchIds={selectedBranchIds}
          budgets={budgets}
          budgetsLoading={budgetsLoading}
          disabled={disabled}
          onToggleBranch={onToggleBranch}
        />
      ) : (
        <ul className="space-y-1">
          {groups.map((group) => (
            <li key={groupKey(group.id)}>
              <GroupRow
                group={group}
                active={group.id === selectedGroupId}
                expanded={expandedGroupKey === groupKey(group.id)}
                selectedBranchIds={selectedBranchIds}
                budgets={budgets}
                budgetsLoading={budgetsLoading}
                disabled={disabled}
                onToggleExpand={onToggleExpand}
                onToggleBranch={onToggleBranch}
                onSetGroupBranches={onSetGroupBranches}
              />
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}

/** The cross-group location finder that sits above the group tree. */
function LocationSearchBox({
  query,
  disabled,
  onChange,
}: Readonly<{ query: string; disabled: boolean; onChange: (query: string) => void }>) {
  return (
    <div className="px-2 pb-2">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
        />
        <Input
          type="search"
          value={query}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Search all locations"
          aria-label="Search locations across all your groups"
          className="h-8 pl-8 pr-8 text-sm"
        />
        {query.length > 0 && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange("")}
            aria-label="Clear location search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:cursor-not-allowed dark:hover:bg-slate-800 dark:hover:text-slate-300"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Search hits, still kept under the group each location belongs to.
 *
 * A hit outside the group being ordered for is drawn unticked for the same
 * reason the tree draws it that way: only one group's locations can be in an
 * order, so a tick there would promise a selection the server refuses. Ticking
 * any hit calls the caller's ordinary toggle with that location's own group id,
 * which is what performs the move - and asks about the cart first.
 */
function LocationSearchResults({
  query,
  results,
  selectedGroupId,
  selectedBranchIds,
  budgets,
  budgetsLoading,
  disabled,
  onToggleBranch,
}: Readonly<{
  query: string
  results: LocationSearchResult
  selectedGroupId: number | null | undefined
  selectedBranchIds: number[]
  budgets?: ReadonlyMap<number, BranchBudgetSummary>
  budgetsLoading: boolean
  disabled: boolean
  onToggleBranch: (groupId: number | null, branchId: number) => void
}>) {
  if (results.matchCount === 0) {
    return (
      <p role="status" className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400">
        No locations match &ldquo;{query.trim()}&rdquo;. Try a branch name, a city, or a cost centre.
      </p>
    )
  }

  return (
    <div className="space-y-2 pb-1">
      {results.groups.length > 1 && (
        <p className="px-3 text-[11px] leading-snug text-slate-400 dark:text-slate-500">
          Matches in {results.groups.length} groups. An order covers one group, so picking a
          location moves your selection to its group.
        </p>
      )}

      {results.groups.map((match) => {
        const active = match.groupId === selectedGroupId
        return (
          <div key={groupKey(match.groupId)}>
            <p className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              <Layers aria-hidden className="h-3 w-3 shrink-0" />
              <span className="min-w-0 truncate" title={match.groupName}>{match.groupName}</span>
              {active && (
                <Badge variant="secondary" className="shrink-0 text-[9px] uppercase">
                  Ordering
                </Badge>
              )}
            </p>
            <ul className="space-y-0.5 pl-2">
              {match.branches.map((branch) => (
                <li key={branch.id}>
                  <BranchRow
                    branch={branch}
                    checked={active && selectedBranchIds.includes(branch.id)}
                    budget={budgets?.get(branch.id)}
                    budgetsLoading={budgetsLoading}
                    disabled={disabled}
                    onToggle={() => onToggleBranch(match.groupId, branch.id)}
                  />
                </li>
              ))}
            </ul>
          </div>
        )
      })}

      {results.truncated && (
        <p className="px-3 pt-1 text-[10px] leading-snug text-slate-400 dark:text-slate-500">
          Showing the first {MAX_LOCATION_MATCHES} matches. Keep typing to narrow them down.
        </p>
      )}
    </div>
  )
}

/** One group: a disclosure header, and its locations when opened. */
function GroupRow({
  group,
  active,
  expanded,
  selectedBranchIds,
  budgets,
  budgetsLoading,
  disabled,
  onToggleExpand,
  onToggleBranch,
  onSetGroupBranches,
}: Readonly<{
  group: ScopedGroup
  active: boolean
  expanded: boolean
  selectedBranchIds: number[]
  budgets?: ReadonlyMap<number, BranchBudgetSummary>
  budgetsLoading: boolean
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
                    budget={budgets?.get(branch.id)}
                    budgetsLoading={budgetsLoading}
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
  budget,
  budgetsLoading,
  disabled,
  onToggle,
}: Readonly<{
  branch: ScopedBranch
  checked: boolean
  budget?: BranchBudgetSummary
  budgetsLoading: boolean
  disabled: boolean
  onToggle: () => void
}>) {
  const inputId = `branch-${branch.id}`
  const budgetId = `branch-${branch.id}-budget`

  return (
    <label
      htmlFor={inputId}
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-sm transition",
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
        className="mt-0.5"
        aria-label={`Order for ${branch.name}`}
        aria-describedby={budget ? budgetId : undefined}
      />
      <Building2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate" title={branch.name}>{branch.name}</span>
          {branch.city && (
            <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-slate-400">
              <MapPin className="h-3 w-3" />
              {branch.city}
            </span>
          )}
        </span>
        <BranchBudgetMeter id={budgetId} budget={budget} loading={budgetsLoading} />
      </span>
    </label>
  )
}

/** Whole rupees: a sidebar row has no width for paisa, and none is meaningful here. */
const WHOLE_RUPEES: Intl.NumberFormatOptions = { maximumFractionDigits: 0 }

/**
 * The total half of "remaining / total", without repeating the currency the
 * remaining figure already carries. Formatted rather than currency-formatted so
 * the result never depends on how a locale happens to place the PKR symbol.
 */
const rupeeAmountFormatter = new Intl.NumberFormat("en-PK", WHOLE_RUPEES)
const plainRupees = (cents: number) =>
  Number.isFinite(cents) ? rupeeAmountFormatter.format(cents / 100) : "0"

/**
 * How much of this location's monthly budget is left, under its name.
 *
 * Three honest states, because they mean different things to a requester:
 * a figure, "no budget set for this month" (head office has to act before any
 * order for this location can be raised), and silence when the figures could
 * not be loaded. Silence is deliberate — an unavailable budget is not a budget
 * of zero, and guessing either way would mislead. Nothing here gates the
 * checkbox: the server re-checks the live budget on every submission and
 * reports a shortfall per location, so this is guidance, not enforcement.
 */
function BranchBudgetMeter({
  id,
  budget,
  loading,
}: Readonly<{ id: string; budget?: BranchBudgetSummary; loading: boolean }>) {
  if (!budget) {
    if (!loading) return null
    return (
      <span
        aria-hidden
        className="block h-2 w-24 animate-pulse rounded-full bg-slate-200 dark:bg-slate-700"
      />
    )
  }

  if (!budget.configured) {
    return (
      <span id={id} className="block text-[10px] font-normal leading-none text-amber-600 dark:text-amber-400">
        No budget set for this month
      </span>
    )
  }

  const ratio = budgetRemainingRatio(budget)
  const exhausted = budget.remainingCents <= 0
  const low = !exhausted && ratio < 0.2

  return (
    <span className="flex flex-col gap-1">
      <span
        id={id}
        className="flex items-baseline gap-1 text-[10px] font-normal leading-none tabular-nums"
      >
        <span
          className={cn(
            "font-semibold",
            exhausted && "text-rose-600 dark:text-rose-400",
            low && "text-amber-600 dark:text-amber-400",
            !exhausted && !low && "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {formatPKR(budget.remainingCents / 100, WHOLE_RUPEES)}
        </span>
        <span className="text-slate-400 dark:text-slate-500">
          / {plainRupees(budget.totalCents)} left
        </span>
      </span>
      <span
        aria-hidden
        className="block h-1 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
      >
        <span
          className={cn(
            "block h-full rounded-full transition-all",
            exhausted && "bg-rose-500",
            low && "bg-amber-500",
            !exhausted && !low && "bg-emerald-500",
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </span>
    </span>
  )
}
