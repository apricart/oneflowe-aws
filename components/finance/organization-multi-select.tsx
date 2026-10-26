"use client"

import { useMemo, useState } from "react"
import { Check, ChevronsUpDown } from "lucide-react"

import { Button, buttonVariants } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  allVisibleSelected,
  clearVisibleOrganizations,
  filterOrganizationOptions,
  organizationSelectionLabel,
  selectVisibleOrganizations,
  toggleOrganization,
  type OrganizationOption,
} from "@/lib/organization-multi-select"
import { cn } from "@/lib/utils"

/**
 * Searchable multi-select of organizations with Select all and Clear, which
 * act on the organizations the search currently shows. Used to give a Finance
 * account its organizations and to filter the payment KPIs. Presentation only:
 * the server validates every id it is sent.
 */
export function OrganizationMultiSelect({
  id,
  options,
  value,
  onChange,
  disabled = false,
  placeholder = "Choose organizations",
  invalid = false,
  describedBy,
}: Readonly<{
  id: string
  options: OrganizationOption[]
  value: number[]
  onChange: (value: number[]) => void
  disabled?: boolean
  /** Shown when nothing is selected. */
  placeholder?: string
  invalid?: boolean
  describedBy?: string
}>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const visible = useMemo(() => filterOrganizationOptions(options, query), [options, query])
  const everyVisibleSelected = allVisibleSelected(value, visible)
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
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          disabled={disabled}
          className={cn(
            buttonVariants({ variant: "outline" }),
            "w-full justify-between font-normal",
            value.length === 0 && "text-muted-foreground",
            invalid && "border-destructive",
          )}
        >
          <span className="min-w-0 truncate">{organizationSelectionLabel(value, options, placeholder)}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[18rem] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search organizations..."
            aria-label="Search organizations"
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
                disabled={visible.length === 0 || everyVisibleSelected}
                onClick={() => onChange(selectVisibleOrganizations(value, visible))}
              >
                {searching ? "Select shown" : "Select all"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={value.length === 0}
                onClick={() => onChange(searching ? clearVisibleOrganizations(value, visible) : [])}
              >
                {searching ? "Clear shown" : "Clear"}
              </Button>
            </div>
          </div>
          <CommandList>
            <CommandEmpty>No organization found.</CommandEmpty>
            <CommandGroup>
              {visible.map((option) => {
                const selected = value.includes(option.id)
                return (
                  <CommandItem
                    key={option.id}
                    value={String(option.id)}
                    aria-selected={selected}
                    onSelect={() => onChange(toggleOrganization(value, option.id))}
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
                    {option.keywords && <span className="ml-2 text-xs text-muted-foreground">{option.keywords}</span>}
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
