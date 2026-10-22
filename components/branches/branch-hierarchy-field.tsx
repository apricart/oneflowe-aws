"use client"

import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  BRANCH_HIERARCHY_LABELS,
  BRANCH_HIERARCHY_ROLES,
  isBranchHierarchyRole,
  type BranchHierarchy,
} from "@/lib/branch-hierarchy"

const TYPE_HINTS = {
  STANDALONE: "Not part of a parent / child family.",
  PARENT: "Other branches of this organization can be created as its children.",
  CHILD: "Belongs to a parent branch. Reports can roll it up under that parent.",
} as const

/**
 * "Branch type" on the branch create and edit forms: Standalone, Parent, or
 * Child of one of `parentOptions` (the organization's parent branches, from
 * `parentBranchOptions`). A label only — it changes no access, budget or price
 * (plans/OF-BRANCH-parent-child-label.md). The server re-checks every rule
 * whatever this sends.
 */
export function BranchHierarchyField({
  id,
  value,
  onChange,
  parentOptions,
  disabled,
  hasChildren = false,
}: Readonly<{
  id: string
  value: BranchHierarchy
  onChange: (value: BranchHierarchy) => void
  parentOptions: ReadonlyArray<{ id: number; name: string; status: string | null }>
  disabled?: boolean
  /** An existing parent with children cannot change type; say so before the server does. */
  hasChildren?: boolean
}>) {
  const parentId = `${id}-parent`
  const hintId = `${id}-hint`
  const parentHintId = `${parentId}-hint`
  const lockedAsParent = hasChildren && value.hierarchyRole === "PARENT"

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={id}>Branch type</Label>
        <Select
          value={value.hierarchyRole}
          onValueChange={(next) => {
            if (!isBranchHierarchyRole(next)) return
            onChange({ hierarchyRole: next, parentBranchId: next === "CHILD" ? value.parentBranchId : null })
          }}
          disabled={disabled || lockedAsParent}
        >
          <SelectTrigger id={id} aria-describedby={hintId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BRANCH_HIERARCHY_ROLES.map((role) => (
              <SelectItem key={role} value={role}>{BRANCH_HIERARCHY_LABELS[role]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p id={hintId} className="text-xs text-muted-foreground">
          {lockedAsParent
            ? "This branch has child branches. Move them to another parent or make them standalone before changing its type."
            : TYPE_HINTS[value.hierarchyRole]}
        </p>
      </div>

      {value.hierarchyRole === "CHILD" && (
        <div className="space-y-2">
          <Label htmlFor={parentId}>Parent branch</Label>
          <Select
            value={value.parentBranchId === null ? "" : String(value.parentBranchId)}
            onValueChange={(next) => onChange({ hierarchyRole: "CHILD", parentBranchId: Number(next) })}
            disabled={disabled || parentOptions.length === 0}
          >
            <SelectTrigger
              id={parentId}
              aria-describedby={parentHintId}
              aria-invalid={value.parentBranchId === null || undefined}
            >
              <SelectValue placeholder="Select the parent branch" />
            </SelectTrigger>
            <SelectContent>
              {parentOptions.map((option) => (
                <SelectItem key={option.id} value={String(option.id)}>
                  {option.name}{option.status && option.status !== "active" ? ` (${option.status})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p
            id={parentHintId}
            className={value.parentBranchId === null ? "text-xs text-red-600 dark:text-red-400" : "text-xs text-muted-foreground"}
          >
            {(() => {
              if (parentOptions.length === 0) return "This organization has no parent branch yet. Create or mark one as Parent first."
              if (value.parentBranchId === null) return "Choose the parent branch."
              return "A parent branch of the same organization."
            })()}
          </p>
        </div>
      )}
    </div>
  )
}
