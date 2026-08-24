"use client"

import * as React from "react"
import { Check, ChevronsUpDown, LayoutGrid, Tag } from "lucide-react"

import { cn } from "@/lib/utils"
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
import {
  ALL_CATEGORIES,
  ALL_CATEGORIES_SELECTION,
  formatSelectionLabel,
  type CategoryGroup,
  type CategorySelection,
} from "@/lib/shop-category-filter"

interface CategoryFilterProps {
  /** Categories present in this branch's catalogue, already scoped by the API. */
  groups: readonly CategoryGroup[]
  selection: CategorySelection
  onSelect: (selection: CategorySelection) => void
  totalCount: number
  className?: string
}

function OptionRow({
  label,
  count,
  selected,
  indented,
  icon,
}: Readonly<{
  label: string
  count?: number
  selected: boolean
  indented?: boolean
  icon?: React.ReactNode
}>) {
  return (
    <>
      <Check className={cn("h-4 w-4 shrink-0 text-blue-600", selected ? "opacity-100" : "opacity-0")} />
      {icon}
      <span className={cn("flex-1 truncate", indented && "text-muted-foreground")}>{label}</span>
      {count !== undefined && (
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {count}
        </span>
      )}
    </>
  )
}

/**
 * Searchable category/subcategory picker for the storefront. Options come from
 * the branch catalogue passed in, never from a categories endpoint — the
 * Order Portal role has no access to those, and they are not branch-scoped.
 */
export function CategoryFilter({
  groups,
  selection,
  onSelect,
  totalCount,
  className,
}: Readonly<CategoryFilterProps>) {
  const [open, setOpen] = React.useState(false)

  const choose = (next: CategorySelection) => {
    onSelect(next)
    setOpen(false)
  }

  const isAll = selection.category === ALL_CATEGORIES
  const label = formatSelectionLabel(selection)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Filter by category"
          className={cn(
            "h-11 w-full justify-between gap-2 rounded-xl border-slate-200/70 bg-white/60 px-3 text-left font-medium backdrop-blur-xl transition-colors hover:bg-white/90 dark:border-slate-700/60 dark:bg-slate-900/50 dark:hover:bg-slate-900/80",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <span
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
                isAll
                  ? "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                  : "bg-blue-600 text-white",
              )}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </span>
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm">{label}</span>
              {!isAll && selection.subCategory !== ALL_CATEGORIES && (
                <span className="truncate text-[11px] font-normal text-muted-foreground">
                  in {selection.category}
                </span>
              )}
            </span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl p-0"
      >
        <Command>
          <CommandInput placeholder="Search categories..." />
          <CommandList className="max-h-[19rem]">
            <CommandEmpty>No categories found.</CommandEmpty>

            <CommandGroup>
              <CommandItem
                value="All Categories"
                onSelect={() => choose(ALL_CATEGORIES_SELECTION)}
                className="gap-2"
              >
                <OptionRow
                  label="All Categories"
                  count={totalCount}
                  selected={isAll}
                  icon={<LayoutGrid className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                />
              </CommandItem>
            </CommandGroup>

            {groups.map((group) => (
              <CommandGroup key={group.name} heading={group.name}>
                <CommandItem
                  value={`${group.name} all`}
                  onSelect={() => choose({ category: group.name, subCategory: ALL_CATEGORIES })}
                  className="gap-2"
                >
                  <OptionRow
                    label={`All of ${group.name}`}
                    count={group.productCount}
                    selected={
                      selection.category === group.name && selection.subCategory === ALL_CATEGORIES
                    }
                  />
                </CommandItem>

                {group.subCategories.map((subCategory) => (
                  <CommandItem
                    key={subCategory}
                    value={`${group.name} ${subCategory}`}
                    onSelect={() => choose({ category: group.name, subCategory })}
                    className="gap-2"
                  >
                    <OptionRow
                      label={subCategory}
                      selected={
                        selection.category === group.name && selection.subCategory === subCategory
                      }
                      indented
                      icon={<Tag className="h-3 w-3 shrink-0 text-muted-foreground" />}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
