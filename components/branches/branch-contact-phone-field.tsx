"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  BRANCH_CONTACT_PHONE_HINT,
  MAX_BRANCH_CONTACT_PHONE,
  parseContactPhoneInput,
} from "@/lib/branch-contact-phone"

/**
 * The number the branch is reached on, as the branch create and edit forms
 * take it. Held as the raw text so a blank field means "not provided"; the form
 * turns it into the API value with `parseContactPhoneInput`, which also decides
 * whether the field is valid — this component only shows that verdict.
 * See plans/OF-BRANCH-contact-phone.md.
 */
export function BranchContactPhoneField({
  id,
  value,
  onChange,
  disabled,
  label = "Contact phone",
  hint = "The number the branch is reached on. Optional.",
}: Readonly<{
  id: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  label?: string
  hint?: string
}>) {
  const invalid = parseContactPhoneInput(value) === undefined
  const hintId = `${id}-hint`

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        maxLength={MAX_BRANCH_CONTACT_PHONE}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="e.g. 0300-1234567"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={hintId}
      />
      <p
        id={hintId}
        className={invalid ? "text-xs text-red-600 dark:text-red-400" : "text-xs text-muted-foreground"}
      >
        {invalid ? BRANCH_CONTACT_PHONE_HINT : hint}
      </p>
    </div>
  )
}

/** The text a form field starts from, for a branch's stored contact phone. */
export function contactPhoneFieldValue(value: string | null | undefined): string {
  return value ?? ""
}
