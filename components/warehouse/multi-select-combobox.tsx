"use client"

import { useMemo, useState } from "react"
import { Check, ChevronsUpDown } from "lucide-react"

import { Button, buttonVariants } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  clearVisible,
  everyVisibleSelected,
  filterOptions,
  selectVisible,
  selectionLabel,
  toggleValue,
  type MultiSelectOption,
} from "@/lib/multi-select"
import { cn } from "@/lib/utils"

export type MultiSelectComboboxOption<Id extends string | number> = MultiSelectOption<Id> & {
  /** Compact context shown beside the label, such as an assignment count. */
  hint?: string
}

/**
 * Searchable multi-select used by the Warehouse Team filters: organizations,
 * and the cities of a rule. Select all and Clear act on what the search shows.
 * It only narrows what the dialog lists; the server validates every save.
 */
export function MultiSelectCombobox<Id extends string | number>({
  id,
  value,
  options,
  disabled,
  onChange,
  nouns,
  placeholder,
}: Readonly<{
  id: string
  value: Id[]
  options: MultiSelectComboboxOption<Id>[]
  disabled: boolean
  onChange: (value: Id[]) => void
  /** How the trigger and search name the options, e.g. organization / organizations. */
  nouns: { one: string; many: string }
  placeholder: string
}>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const visible = useMemo(() => filterOptions(options, query), [options, query])
  const searching = query.trim().length > 0

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery("")
      }}
      modal
    >
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(buttonVariants({ variant: "outline" }), "w-full justify-between font-normal", value.length === 0 && "text-muted-foreground")}
        >
          <span className="min-w-0 truncate">{selectionLabel(value, options, placeholder, nouns)}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[18rem] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={`Search ${nouns.many}...`}
            aria-label={`Search ${nouns.many}`}
            value={query}
            onValueChange={setQuery}
          />
          <div className="flex items-center justify-between gap-2 border-b px-2 py-1.5">
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {value.length} of {options.length} selected
            </span>
            <div className="flex gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={visible.length === 0 || everyVisibleSelected(value, visible)}
                onClick={() => onChange(selectVisible(value, visible))}
              >
                {searching ? "Select shown" : "Select all"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={value.length === 0}
                onClick={() => onChange(searching ? clearVisible(value, visible) : [])}
              >
                {searching ? "Clear shown" : "Clear"}
              </Button>
            </div>
          </div>
          <CommandList>
            <CommandEmpty>No {nouns.one} found.</CommandEmpty>
            <CommandGroup>
              {visible.map((option) => {
                const selected = value.includes(option.id)
                return (
                  <CommandItem
                    key={String(option.id)}
                    value={String(option.id)}
                    aria-selected={selected}
                    onSelect={() => onChange(toggleValue(value, option.id))}
                  >
                    <span
                      className={cn(
                        "mr-2 flex h-4 w-4 items-center justify-center rounded-sm border border-primary",
                        selected ? "bg-primary text-primary-foreground" : "opacity-50",
                      )}
                      aria-hidden="true"
                    >
                      {selected && <Check className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.hint && <span className="ml-2 text-xs text-muted-foreground">{option.hint}</span>}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
