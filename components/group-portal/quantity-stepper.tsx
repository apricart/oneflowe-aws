"use client"

import { useState } from "react"
import { Minus, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { snapQuantityToStep } from "@/lib/quantity"

/**
 * The one control that changes a quantity in the Group Order Portal.
 *
 * Shared by the items step and the review step so a quantity behaves the same
 * wherever it is edited: typing is held as draft text and committed on blur or
 * Enter, the step comes from the product's own rules, and anything that cannot
 * be read as a positive number commits as zero — which every caller treats as
 * "remove this line" rather than as an error to argue with.
 *
 * Every committed value is snapped onto the product's step, typed values
 * included. A product sold in halves cannot be talked into 0.37 by typing it,
 * which is what stopped the server refusing a branch at submit time for a
 * quantity this control had accepted on screen.
 */
export function QuantityStepper({
  value,
  step,
  label,
  disabled = false,
  onChange,
}: Readonly<{
  value: number
  step: number
  label: string
  disabled?: boolean
  onChange: (value: number) => void
}>) {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (raw: string) => {
    onChange(snapQuantityToStep(raw, step))
    setDraft(null)
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8"
        aria-label={`Decrease ${label}`}
        disabled={disabled || value <= 0}
        onClick={() => onChange(snapQuantityToStep(Math.max(0, value - step), step))}
      >
        <Minus className="h-3.5 w-3.5" />
      </Button>
      <Input
        value={draft ?? (value > 0 ? String(value) : "")}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur()
        }}
        inputMode="decimal"
        placeholder="0"
        aria-label={label}
        disabled={disabled}
        className="h-8 w-16 text-center"
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8"
        aria-label={`Increase ${label}`}
        disabled={disabled}
        onClick={() => onChange(snapQuantityToStep(value + step, step))}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
