"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MAX_BRANCH_HEAD_COUNT, parseHeadCountInput } from "@/lib/branch-head-count"

/**
 * How many people work at the branch, as the branch create and edit forms take
 * it. Held as the raw text so a blank field means "not provided"; the form
 * turns it into the API value with `parseHeadCountInput`, which also decides
 * whether the field is valid — this component only shows that verdict.
 */
export function BranchHeadCountField({
  id,
  value,
  onChange,
  disabled,
  label = "Head count",
  hint = "How many people work at this branch. Optional.",
}: Readonly<{
  id: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  label?: string
  hint?: string
}>) {
  const invalid = parseHeadCountInput(value) === undefined
  const hintId = `${id}-hint`

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={MAX_BRANCH_HEAD_COUNT}
        step={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="e.g. 25"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={hintId}
      />
      <p
        id={hintId}
        className={invalid ? "text-xs text-red-600 dark:text-red-400" : "text-xs text-muted-foreground"}
      >
        {invalid
          ? `Enter a whole number from 0 to ${MAX_BRANCH_HEAD_COUNT.toLocaleString("en-US")}.`
          : hint}
      </p>
    </div>
  )
}

/** The text a form field starts from, for a branch's stored head count. */
export function headCountFieldValue(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : ""
}
