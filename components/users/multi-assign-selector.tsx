"use client"

import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Check, ChevronsUpDown } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Shared by the create dialog and the user-edit dialog.
 *
 * Both screens grant the same thing — the set of groups and branches a
 * group-based role reaches — so they use one control. Extracted from
 * `create-user-dialog.tsx` when editing gained the ability to move a user into
 * a group role, because two implementations of this would drift and the scope
 * it grants is exactly what `validateMultiBranchScope` checks on the server.
 */
export type AssignOption = {
  id: string
  label: string
  hint?: string
}

/**
 * Searchable multi-select used for the Group Order Portal scope. Selection is
 * additive and every chosen item stays visible as a removable chip, so an
 * administrator can always see the full reach they are granting.
 */
export function MultiAssignSelector({
  id,
  label,
  placeholder,
  emptyLabel,
  disabledLabel,
  disabled,
  options,
  selectedIds,
  onToggle,
  onClear,
  helpText,
}: Readonly<{
  id: string
  label: string
  placeholder: string
  emptyLabel: string
  disabledLabel: string
  disabled: boolean
  options: AssignOption[]
  selectedIds: string[]
  onToggle: (id: string) => void
  onClear: () => void
  helpText: string
}>) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")

  const selectedSet = new Set(selectedIds)
  const selectedOptions = options.filter((option) => selectedSet.has(option.id))

  const triggerLabel = (() => {
    if (disabled) return disabledLabel
    if (selectedIds.length === 0) return placeholder
    return `${selectedIds.length} selected`
  })()

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        {selectedIds.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={onClear}
          >
            Clear
          </Button>
        )}
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            name={id}
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className={cn(
              "w-full justify-between font-normal",
              selectedIds.length === 0 && "text-muted-foreground",
            )}
          >
            {triggerLabel}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command>
            <CommandInput placeholder={placeholder} value={search} onValueChange={setSearch} />
            <CommandList>
              <CommandEmpty>{emptyLabel}</CommandEmpty>
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={`${option.label}__${option.id}`}
                    onSelect={() => onToggle(option.id)}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        selectedSet.has(option.id) ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="flex-1">{option.label}</span>
                    {option.hint && (
                      <span className="ml-2 text-xs text-muted-foreground">{option.hint}</span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selectedOptions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedOptions.map((option) => (
            <Badge
              key={option.id}
              variant="secondary"
              className="cursor-pointer gap-1"
              onClick={() => onToggle(option.id)}
            >
              {option.label}
              <span aria-hidden="true">×</span>
            </Badge>
          ))}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground">{helpText}</p>
    </div>
  )
}
