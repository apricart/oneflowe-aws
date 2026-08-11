"use client"

import React from "react"
import useSWR from "swr"
import { Package } from "lucide-react"
import { MultiSelectFilter } from "./multi-select-filter"
import { cn } from "@/lib/utils"

const fetcher = (url: string) => fetch(url).then((res) => res.json())

interface Product {
    id: number | string
    name: string
    productCode?: string
}

interface ProductFilterProps {
    selectedIds: string[]
    onChange: (ids: string[]) => void
    organizationId?: string | number
    organizationIds?: string[]
    groupIds?: string[]
    branchIds?: string[]
    placeholder?: string
    disabled?: boolean
}

export function ProductFilter({ 
    selectedIds, 
    onChange, 
    organizationId,
    organizationIds,
    groupIds,
    branchIds,
    placeholder = "Select Products",
    disabled = false
}: Readonly<ProductFilterProps>) {
    const params = new URLSearchParams()
    
    // Combine single organizationId and organizationIds array
    const allOrgIds = new Set<string>()
    if (organizationId) allOrgIds.add(String(organizationId))
    if (organizationIds?.length) organizationIds.forEach(id => allOrgIds.add(String(id)))
    
    if (allOrgIds.size > 0) params.set("organizationIds", Array.from(allOrgIds).join(","))
    if (groupIds?.length) params.set("groupIds", groupIds.join(","))
    if (branchIds?.length) params.set("branchIds", branchIds.join(","))

    const { data, isLoading } = useSWR(
        `/api/v1/analytics/products/list?${params.toString()}`,
        fetcher,
        { revalidateOnFocus: false }
    )

    const products = (data?.items || []) as Product[]
    const items = products.map(p => ({ 
        id: p.id.toString(), 
        label: p.productCode ? `[${p.productCode}] ${p.name}` : p.name 
    }))

    return (
        <MultiSelectFilter
            title="Products"
            items={items}
            selectedIds={selectedIds}
            onChange={onChange}
            disabled={disabled || isLoading}
            icon={<Package className={cn("h-4 w-4 shrink-0", (selectedIds.length > 0 || disabled) ? "text-indigo-600" : "text-slate-400")} />}
            placeholder={isLoading ? "Loading..." : placeholder}
            className="w-[300px]"
        />
    )
}

