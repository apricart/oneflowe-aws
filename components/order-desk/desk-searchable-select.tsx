"use client"

import { useState } from "react"
import { Check, ChevronsUpDown } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export type DeskSelectOption = {
  id: number
  label: string
  /** Shown beside the label and searched with it, such as the branch's city. */
  hint?: string
  /** Extra searchable text that is not shown, such as the organization's code. */
  keywords?: string
}

/**
 * A searchable single choice of an organization or branch on the Order Desk.
 * With `allLabel` the first entry clears the choice (a list filter); without
 * it something must be chosen (the new-order form). It only picks from the
 * options the desk's reach already returned — the server checks every choice.
 */
export function DeskSearchableSelect({
  id,
  ariaLabel,
  value,
  options,
  placeholder,
  allLabel,
  searchLabel,
  emptyLabel,
  disabled = false,
  onValueChange,
}: Readonly<{
  id?: string
  ariaLabel?: string
  value: number | null
  options: DeskSelectOption[]
  /** Shown when nothing is chosen and there is no `allLabel`. */
  placeholder: string
  allLabel?: string
  /** The search box's placeholder and accessible name, e.g. "Search branches". */
  searchLabel: string
  emptyLabel: string
  disabled?: boolean
  onValueChange: (value: number | null) => void
}>) {
  const [open, setOpen] = useState(false)
  const selected = options.find((option) => option.id === value)
  const shown = selected ? selected.label : allLabel ?? placeholder

  function choose(next: number | null) {
    onValueChange(next)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel ? `${ariaLabel}: ${shown}` : undefined}
          disabled={disabled}
          className={cn(
            buttonVariants({ variant: "outline" }),
            "w-full justify-between font-normal",
            !selected && !allLabel && "text-muted-foreground",
          )}
        >
          <span className="min-w-0 truncate">
            {shown}
            {selected?.hint && <span className="ml-1 text-muted-foreground">{selected.hint}</span>}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0" align="start">
        <Command>
          <CommandInput placeholder={`${searchLabel}...`} aria-label={searchLabel} />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              {allLabel && (
                <CommandItem value={`__all__ ${allLabel}`} onSelect={() => choose(null)}>
                  <Check className={cn("mr-2 h-4 w-4", value === null ? "opacity-100" : "opacity-0")} aria-hidden="true" />
                  {allLabel}
                </CommandItem>
              )}
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={`${option.label} ${option.hint ?? ""} ${option.keywords ?? ""} ${option.id}`}
                  onSelect={() => choose(option.id)}
                >
                  <Check
                    className={cn("mr-2 h-4 w-4", option.id === value ? "opacity-100" : "opacity-0")}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.hint && <span className="ml-2 max-w-[45%] truncate text-xs text-muted-foreground">{option.hint}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
