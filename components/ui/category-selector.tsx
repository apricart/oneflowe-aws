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
import { Check,ChevronsUpDown,FolderTree,FolderOpen } from "lucide-react"
import { cn } from "@/lib/utils"
import useSWR from "swr"

interface Category {
  id: number
  name: string
  parentId: number | null
  subCategoriesCount?: number
  productsCount?: number
}

interface CategorySelectorProps {
  value?: number | null
  onChange: (categoryId: number | null) => void
  placeholder?: string
  showSubCategories?: boolean
  className?: string
}

const fetcher = (url: string) => fetch(url).then(res => res.json())

export function CategorySelector({
  value,
  onChange,
  placeholder = "Select category...",
  showSubCategories = true,
  className
}: Readonly<CategorySelectorProps>) {
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")

  // Fetch categories
  const { data: categoriesData } = useSWR<{ items: Category[] }>(
    `/api/v1/categories?type=parent`,
    fetcher
  )

  // Fetch subcategories if needed
  const { data: subCategoriesData } = useSWR<{ items: Category[] }>(
    showSubCategories ? `/api/v1/subcategories` : null,
    fetcher
  )

  const categories = categoriesData?.items || []
  const subCategories = subCategoriesData?.items || []

  // Find selected category
  const selectedCategory = categories.find(cat => cat.id === value)
  const selectedSubCategory = subCategories.find(cat => cat.id === value)

  // Filter categories by search
  const filteredCategories = categories.filter(category =>
    category.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const filteredSubCategories = subCategories.filter(subCategory =>
    subCategory.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleSelect = (categoryId: number, isSubCategory: boolean = false) => {
    onChange(categoryId)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("justify-between", className)}
        >
          {(() => {
            if (selectedCategory) {
              return (
            <div className="flex items-center gap-2">
              <FolderTree size={16} />
              <span>{selectedCategory.name}</span>
            </div>
          )
            }
            if (selectedSubCategory) {
              return (
            <div className="flex items-center gap-2">
              <FolderOpen size={16} />
              <span>{selectedSubCategory.name}</span>
            </div>
          )
            }
            return (
            placeholder
          )
          })()}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-0">
        <Command>
          <CommandInput
            placeholder="Search categories..."
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandList>
            <CommandEmpty>No categories found.</CommandEmpty>
            
            {/* Parent Categories */}
            {filteredCategories.length > 0 && (
              <CommandGroup heading="Categories">
                {filteredCategories.map((category) => (
                  <CommandItem
                    key={category.id}
                    value={category.name}
                    onSelect={() => handleSelect(category.id, false)}
                    className="flex items-center gap-2"
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value === category.id ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <FolderTree size={16} />
                    <span className="flex-1">{category.name}</span>
                    <div className="flex gap-1">
                      {category.subCategoriesCount !== undefined && (
                        <Badge variant="outline" className="text-xs">
                          {category.subCategoriesCount} sub
                        </Badge>
                      )}
                      {category.productsCount !== undefined && (
                        <Badge variant="secondary" className="text-xs">
                          {category.productsCount} products
                        </Badge>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Sub Categories */}
            {showSubCategories && filteredSubCategories.length > 0 && (
              <CommandGroup heading="Sub Categories">
                {filteredSubCategories.map((subCategory) => (
                  <CommandItem
                    key={subCategory.id}
                    value={subCategory.name}
                    onSelect={() => handleSelect(subCategory.id, true)}
                    className="flex items-center gap-2 ml-4"
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value === subCategory.id ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <FolderOpen size={16} />
                    <span className="flex-1">{subCategory.name}</span>
                    {subCategory.productsCount !== undefined && (
                      <Badge variant="secondary" className="text-xs">
                        {subCategory.productsCount} products
                      </Badge>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
