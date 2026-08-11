"use client"

import React from "react"
import { Building2 } from "lucide-react"
import { useOrganizations } from "@/lib/hooks/use-api"
import { cn } from "@/lib/utils"
import { MultiSelectFilter } from "./multi-select-filter"

interface Organization {
    id: number
    name: string
}

interface OrganizationFilterProps {
    selectedIds: string[]
    onChange: (ids: string[]) => void
    placeholder?: string
    maxSelect?: number
}

export function OrganizationFilter({ 
    selectedIds, 
    onChange, 
    placeholder = "Select Organizations",
    maxSelect
}: Readonly<OrganizationFilterProps>) {
    const { data } = useOrganizations()
    const orgs = (data?.items || []) as Organization[]
    const items = orgs.map(o => ({ id: o.id.toString(), label: o.name }))

    return (
        <MultiSelectFilter
            title={maxSelect === 1 ? "Organization" : "Organizations"}
            items={items}
            selectedIds={selectedIds}
            onChange={onChange}
            icon={<Building2 className={cn("h-4 w-4 shrink-0", selectedIds.length > 0 ? "text-indigo-600" : "text-slate-400")} />}
            placeholder={placeholder}
            className="w-[220px]"
            maxSelect={maxSelect}
        />
    )
}
