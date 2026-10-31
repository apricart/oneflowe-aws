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

export type SupportFilterOption = {
  id: number
  label: string
  /** Shown beside the label and searched with it, such as the organization. */
  hint?: string
}

/**
 * A searchable single-choice filter for the support queue: organization, branch
 * or group. The first entry clears it. Choosing narrows the list only — the
 * server applies every filter on top of the caller's own scope.
 */
export function SupportFilterCombobox({
  value,
  options,
  allLabel,
  searchLabel,
  emptyLabel,
  onValueChange,
}: Readonly<{
  value: number | null
  options: SupportFilterOption[]
  /** The cleared state, e.g. "Any branch". */
  allLabel: string
  /** The search box's placeholder and accessible name, e.g. "Search branches". */
  searchLabel: string
  emptyLabel: string
  onValueChange: (value: number | null) => void
}>) {
  const [open, setOpen] = useState(false)
  const selected = options.find((option) => option.id === value)

  function choose(next: number | null) {
    onValueChange(next)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={selected ? `${allLabel}: ${selected.label}` : allLabel}
          className={cn(buttonVariants({ variant: "outline" }), "w-[190px] justify-between font-normal")}
        >
          <span className="min-w-0 truncate">{selected ? selected.label : allLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder={`${searchLabel}...`} aria-label={searchLabel} />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              <CommandItem value={`__all__ ${allLabel}`} onSelect={() => choose(null)}>
                <Check className={cn("mr-2 h-4 w-4", value === null ? "opacity-100" : "opacity-0")} aria-hidden="true" />
                {allLabel}
              </CommandItem>
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={`${option.label} ${option.hint ?? ""} ${option.id}`}
                  onSelect={() => choose(option.id)}
                >
                  <Check
                    className={cn("mr-2 h-4 w-4", option.id === value ? "opacity-100" : "opacity-0")}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.hint ? (
                    <span className="ml-2 max-w-[45%] truncate text-xs text-muted-foreground">{option.hint}</span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
