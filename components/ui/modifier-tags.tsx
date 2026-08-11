"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Check,ChevronsUpDown,Tag,X,Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import useSWR from "swr"

interface Modifier {
  id: number
  name: string
  type: string
  status: string
}

interface ModifierTagsProps {
  value: number[]
  onChange: (modifierIds: number[]) => void
  placeholder?: string
  className?: string
  maxTags?: number
}

const fetcher = (url: string) => fetch(url).then(res => res.json())

const MODIFIER_TYPES = [
  { value: "unit", label: "Unit", color: "bg-blue-100 text-blue-800" },
  { value: "size", label: "Size", color: "bg-green-100 text-green-800" },
  { value: "packaging", label: "Packaging", color: "bg-purple-100 text-purple-800" },
  { value: "weight", label: "Weight", color: "bg-orange-100 text-orange-800" },
  { value: "volume", label: "Volume", color: "bg-cyan-100 text-cyan-800" },
  { value: "count", label: "Count", color: "bg-pink-100 text-pink-800" },
]

export function ModifierTags({
  value,
  onChange,
  placeholder = "Select modifiers...",
  className,
  maxTags
}: Readonly<ModifierTagsProps>) {
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")

  // Fetch modifiers
  const { data: modifiersData } = useSWR<{ items: Modifier[] }>(
    `/api/v1/modifiers?status=active`,
    fetcher
  )

  const modifiers = modifiersData?.items || []

  // Get selected modifiers
  const selectedModifiers = modifiers.filter(modifier => value.includes(modifier.id))

  // Filter modifiers by search
  const filteredModifiers = modifiers.filter(modifier =>
    modifier.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    modifier.type.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleToggle = (modifierId: number) => {
    const isSelected = value.includes(modifierId)
    if (isSelected) {
      onChange(value.filter(id => id !== modifierId))
    } else {
      if (maxTags && value.length >= maxTags) {
        return // Don't add if max tags reached
      }
      onChange([...value, modifierId])
    }
  }

  const handleRemove = (modifierId: number) => {
    onChange(value.filter(id => id !== modifierId))
  }

  const getTypeColor = (type: string) => {
    const typeConfig = MODIFIER_TYPES.find(t => t.value === type)
    return typeConfig?.color || "bg-gray-100 text-gray-800"
  }

  const getTypeLabel = (type: string) => {
    const typeConfig = MODIFIER_TYPES.find(t => t.value === type)
    return typeConfig?.label || type
  }

  return (
    <div className={cn("space-y-2", className)}>
      {/* Selected Modifiers */}
      {selectedModifiers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedModifiers.map((modifier) => (
            <Badge
              key={modifier.id}
              variant="secondary"
              className={cn("flex items-center gap-1", getTypeColor(modifier.type))}
            >
              <Tag size={12} />
              <span>{modifier.name}</span>
              <button type="button"
                onClick={() => handleRemove(modifier.id)}
                className="ml-1 hover:bg-black/10 rounded-full p-0.5"
              >
                <X size={12} />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* Add Modifier Button */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between"
            disabled={maxTags ? value.length >= maxTags : false}
          >
            <div className="flex items-center gap-2">
              <Plus size={16} />
              <span>
                {maxTags && value.length >= maxTags
                  ? `Maximum ${maxTags} modifiers selected`
                  : placeholder
                }
              </span>
            </div>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[400px] p-0">
          <Command>
            <CommandInput
              placeholder="Search modifiers..."
              value={searchQuery}
              onValueChange={setSearchQuery}
            />
            <CommandList>
              <CommandEmpty>No modifiers found.</CommandEmpty>

              {/* Group by type */}
              {Object.entries(
                filteredModifiers.reduce((acc, modifier) => {
                  if (!acc[modifier.type]) {
                    acc[modifier.type] = []
                  }
                  acc[modifier.type].push(modifier)
                  return acc
                }, {} as Record<string, Modifier[]>)
              ).map(([type, typeModifiers]) => (
                <CommandGroup key={type} heading={getTypeLabel(type)}>
                  {typeModifiers.map((modifier) => {
                    const isSelected = value.includes(modifier.id)
                    const isDisabled = maxTags ? (!isSelected && value.length >= maxTags) : false

                    return (
                      <CommandItem
                        key={modifier.id}
                        value={modifier.name}
                        onSelect={() => handleToggle(modifier.id)}
                        className={cn(
                          "flex items-center gap-2",
                          isDisabled && "opacity-50 cursor-not-allowed"
                        )}
                        disabled={isDisabled}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            isSelected ? "opacity-100" : "opacity-0"
                          )}
                        />
                        <Tag size={16} />
                        <span className="flex-1">{modifier.name}</span>
                        <Badge
                          variant="outline"
                          className={cn("text-xs", getTypeColor(modifier.type))}
                        >
                          {getTypeLabel(modifier.type)}
                        </Badge>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Helper text */}
      {maxTags && (
        <p className="text-xs text-muted-foreground">
          {value.length} of {maxTags} modifiers selected
        </p>
      )}
    </div>
  )
}
