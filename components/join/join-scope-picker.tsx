"use client"

import { Check } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export type JoinOption = { id: number; name: string }

/**
 * Picking which branch, or which groups and branches, to ask for.
 *
 * Presentation only. Which of these a role may carry is decided by
 * `joinRequestScopeShapeError`, and whether each id belongs to the organization
 * the code resolved is decided on the server — this list is filled from the
 * lookup response and may not be trusted as proof of anything.
 */

export function JoinSingleBranchPicker({
  options,
  value,
  onChange,
  error,
}: Readonly<{
  options: JoinOption[]
  value: number | null
  onChange: (branchId: number) => void
  error?: string
}>) {
  if (options.length === 0) {
    return (
      <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        This organization has no branches available to join yet. Contact its head office.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <label htmlFor="join-branch" className="text-sm font-medium text-slate-700">
        Branch <span className="text-red-500">*</span>
      </label>
      <select
        id="join-branch"
        value={value ?? ""}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? "join-branch-error" : undefined}
        className={cn(
          "h-10 w-full rounded-md border bg-white px-3 text-sm text-slate-900",
          error ? "border-red-400" : "border-slate-300",
        )}
      >
        <option value="">Select your branch</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>{option.name}</option>
        ))}
      </select>
      {error && (
        <p id="join-branch-error" className="text-xs font-medium text-red-600">{error}</p>
      )}
    </div>
  )
}

function OptionList({
  legend,
  emptyText,
  options,
  selected,
  onToggle,
}: Readonly<{
  legend: string
  emptyText: string
  options: JoinOption[]
  selected: number[]
  onToggle: (id: number) => void
}>) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-slate-700">{legend}</legend>
      {options.length === 0 ? (
        <p className="text-xs text-slate-500">{emptyText}</p>
      ) : (
        <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-slate-200 bg-white p-2">
          {options.map((option) => {
            const isSelected = selected.includes(option.id)
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onToggle(option.id)}
                className={cn(
                  "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm",
                  isSelected ? "bg-blue-50 text-blue-900" : "text-slate-700 hover:bg-slate-50",
                )}
              >
                <span>{option.name}</span>
                {isSelected && <Check className="h-4 w-4 text-blue-600" aria-hidden="true" />}
              </button>
            )
          })}
        </div>
      )}
    </fieldset>
  )
}

export function JoinMultiScopePicker({
  groups,
  branches,
  selectedGroupIds,
  selectedBranchIds,
  onToggleGroup,
  onToggleBranch,
  error,
}: Readonly<{
  groups: JoinOption[]
  branches: JoinOption[]
  selectedGroupIds: number[]
  selectedBranchIds: number[]
  onToggleGroup: (id: number) => void
  onToggleBranch: (id: number) => void
  error?: string
}>) {
  const total = selectedGroupIds.length + selectedBranchIds.length

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-700">
          Groups and branches <span className="text-red-500">*</span>
        </p>
        <Badge variant="secondary">{total} selected</Badge>
      </div>
      <p className="text-xs text-slate-500">
        Choose at least one group or one branch you will be ordering for. Your head office can
        change this before approving.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <OptionList
          legend="Groups"
          emptyText="No groups available."
          options={groups}
          selected={selectedGroupIds}
          onToggle={onToggleGroup}
        />
        <OptionList
          legend="Individual branches"
          emptyText="No branches available."
          options={branches}
          selected={selectedBranchIds}
          onToggle={onToggleBranch}
        />
      </div>
      {error && <p className="text-xs font-medium text-red-600">{error}</p>}
    </div>
  )
}
