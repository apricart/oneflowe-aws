"use client"

import React from "react"
import { Building2 } from "lucide-react"
import { useBranches } from "@/lib/hooks/use-api"
import { cn } from "@/lib/utils"
import { MultiSelectFilter } from "./multi-select-filter"

interface Branch {
    id: number
    name: string
    groupName?: string | null
}

interface BranchFilterProps {
    selectedIds: string[]
    onChange: (ids: string[]) => void
    organizationId?: string | number
    organizationIds?: (string | number)[]
    groupIds?: (string | number)[]
    placeholder?: string
    disabled?: boolean
}

export function BranchFilter({ 
    selectedIds, 
    onChange, 
    organizationId, 
    organizationIds,
    groupIds,
    placeholder = "Select Branches",
    disabled = false
}: Readonly<BranchFilterProps>) {
    const orgQuery = (() => {
      if (organizationIds?.length) {
        return organizationIds.join(",")
      }
      return (organizationId ? String(organizationId) : undefined)
    })()
    const groupQuery = groupIds?.length ? groupIds.join(",") : undefined
    
    // Updated useBranches hook or manual fetching to support groupIds
    const { data } = useBranches(orgQuery, groupQuery)
    const branches = (data?.items || []) as Branch[]
    const items = branches.map(b => ({ id: b.id.toString(), label: b.name }))

    return (
        <MultiSelectFilter
            title="Branches"
            items={items}
            selectedIds={selectedIds}
            onChange={onChange}
            disabled={disabled}
            icon={<Building2 className={cn("h-4 w-4 shrink-0", (selectedIds.length > 0 || disabled) ? "text-indigo-600" : "text-slate-400")} />}
            placeholder={disabled ? `All Branches in ${branches[0]?.groupName || 'Group'}` : placeholder}
            className="w-[280px]"
        />
    )
}
