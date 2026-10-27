"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  PRICE_CONTRACT_DATE_MAX,
  PRICE_CONTRACT_DATE_MIN,
  PRICE_CONTRACT_REMINDER_DAYS,
  priceContractDateRefusal,
} from "@/lib/price-contract-validity"

/** Why the drafted date cannot be saved, or null when it can. Blank is fine: no contract date. */
export function priceContractDraftError(draft: string): string | null {
  return draft.trim() === "" ? null : priceContractDateRefusal(draft.trim())
}

/** What the dialogs send: the day, or null for "no contract date". */
export function toPriceContractPayload(draft: string): string | null {
  return draft.trim() || null
}

/**
 * The last day the organization's agreed prices are valid for, as Create and
 * Edit Company ask for it. Judged by the same rule the API uses. A reminder
 * only: it never stops anyone ordering.
 */
export function PriceContractField({
  id,
  value,
  onChange,
  disabled,
}: Readonly<{
  id: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}>) {
  const problem = priceContractDraftError(value)
  const hintId = `${id}-hint`
  const errorId = `${id}-error`

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Price contract valid until (optional)</Label>
      <Input
        id={id}
        type="date"
        value={value}
        min={PRICE_CONTRACT_DATE_MIN}
        max={PRICE_CONTRACT_DATE_MAX}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-invalid={Boolean(problem)}
        aria-describedby={problem ? `${hintId} ${errorId}` : hintId}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        The last day this organization&apos;s agreed product prices are valid. Super Admins and its assigned
        executives are reminded {PRICE_CONTRACT_REMINDER_DAYS} days before. Ordering is never blocked.
      </p>
      {problem && (
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
          {problem}
        </p>
      )}
    </div>
  )
}
