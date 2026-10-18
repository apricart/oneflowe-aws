"use client"

import { useState } from "react"

import { Check, ChevronsUpDown } from "lucide-react"

import { Button } from "@/components/ui/button"
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
import { PAKISTAN_CITIES, type PakistanCity } from "@/lib/pakistan-cities"

/**
 * Choosing a city from Pakistan's list (plans/OF-JOIN-new-branch-city-warehouse.md):
 * searchable by city or province, nothing typed is ever taken as a city. The
 * server refuses a city that is not on the list whatever this sends.
 *
 * `modal` on the popover: inside a dialog, a non-modal popover's list cannot
 * be scrolled with the wheel, because the dialog's scroll lock owns it.
 */
export function PakistanCityCombobox({
  value,
  onSelect,
  label = "City",
  invalid = false,
  describedBy,
}: Readonly<{
  value: string
  onSelect: (city: PakistanCity) => void
  label?: string
  invalid?: boolean
  describedBy?: string
}>) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className={cn("w-full justify-between font-normal", !value && "text-muted-foreground")}
        >
          <span className="truncate">{value || "Choose a city"}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[16rem] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search cities…" aria-label={`Search ${label.toLowerCase()}`} />
          <CommandList>
            <CommandEmpty>No city found. Choose the nearest listed city.</CommandEmpty>
            <CommandGroup>
              {PAKISTAN_CITIES.map((city) => (
                <CommandItem
                  key={city.name}
                  // Searched by city and province alike: "Sindh" lists Sindh's cities.
                  value={`${city.name} ${city.province}`}
                  onSelect={() => {
                    onSelect(city)
                    setOpen(false)
                  }}
                >
                  <Check className={cn("mr-2 h-4 w-4", value === city.name ? "opacity-100" : "opacity-0")} aria-hidden="true" />
                  <span className="flex-1">{city.name}</span>
                  <span className="text-xs text-muted-foreground">{city.province}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
