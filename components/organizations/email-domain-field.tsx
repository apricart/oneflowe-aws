"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  EMAIL_DOMAIN_MAX_LENGTH,
  emailDomainError,
  normalizeEmailDomain,
} from "@/lib/organization-email-domain"

/**
 * Why the drafted domain cannot be saved, or null when it can. Blank is fine:
 * the domain is optional, and an organization without one simply cannot be
 * joined through the public form.
 */
export function emailDomainDraftError(draft: string): string | null {
  return draft.trim() === "" ? null : emailDomainError(draft)
}

/** What the dialogs send: the normalised domain, or null for "none". */
export function toEmailDomainPayload(draft: string): string | null {
  return normalizeEmailDomain(draft) || null
}

/**
 * The organization's email domain, as Create and Edit Company ask for it.
 *
 * Judged by the same `emailDomainError` the API and the check constraint use, so
 * the dialog cannot accept a domain the server would refuse.
 */
export function EmailDomainField({
  id,
  value,
  onChange,
  disabled,
  hint,
}: Readonly<{
  id: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  hint: string
}>) {
  const problem = emailDomainDraftError(value)
  const hintId = `${id}-hint`
  const errorId = `${id}-error`

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Email domain (optional)</Label>
      <div className="flex">
        <span
          aria-hidden="true"
          className="inline-flex items-center rounded-l-md border border-r-0 bg-muted px-3 text-sm text-muted-foreground"
        >
          @
        </span>
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="company.com"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={EMAIL_DOMAIN_MAX_LENGTH + 1}
          disabled={disabled}
          className="rounded-l-none"
          aria-invalid={Boolean(problem)}
          aria-describedby={problem ? `${hintId} ${errorId}` : hintId}
        />
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">{hint}</p>
      {problem && (
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
          {problem}
        </p>
      )}
    </div>
  )
}
