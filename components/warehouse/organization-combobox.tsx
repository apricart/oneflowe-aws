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

export type OrganizationComboboxOption = {
  id: number
  label: string
  /** Extra searchable text, such as the organization's short code. */
  keywords?: string
  /** Compact context shown beside the name, such as an assignment count. */
  hint?: string
}

/**
 * Searchable organization picker shared by the two warehouse branch dialogs.
 * It chooses only the organization whose branches are being edited; it does
 * not grant access. The server remains responsible for validating every save.
 */
export function OrganizationCombobox({
  id,
  value,
  options,
  disabled,
  onValueChange,
}: Readonly<{
  id: string
  value: number | null
  options: OrganizationComboboxOption[]
  disabled: boolean
  onValueChange: (value: number) => void
}>) {
  const [open, setOpen] = useState(false)
  const selected = options.find((option) => option.id === value)

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(buttonVariants({ variant: "outline" }), "w-full justify-between font-normal", !selected && "text-muted-foreground")}
        >
          <span className="min-w-0 truncate">
            {selected ? selected.label : "Choose an organization"}
            {selected?.hint && <span className="ml-1 text-muted-foreground">{selected.hint}</span>}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[18rem] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search organizations..." aria-label="Search organizations" />
          <CommandList>
            <CommandEmpty>No organization found.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={`${option.label} ${option.keywords ?? ""} ${option.id}`}
                  onSelect={() => {
                    onValueChange(option.id)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn("mr-2 h-4 w-4", option.id === value ? "opacity-100" : "opacity-0")}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.hint && <span className="ml-2 text-xs text-muted-foreground">{option.hint}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
