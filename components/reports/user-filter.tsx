"use client"

import React from "react"
import useSWR from "swr"
import { UserCircle } from "lucide-react"
import { MultiSelectFilter } from "./multi-select-filter"
import { cn } from "@/lib/utils"

const fetcher = (url: string) => fetch(url).then((res) => res.json())

interface User {
    id: string
    name: string
    employeeId: string
}

interface UserFilterProps {
    selectedIds: string[]
    onChange: (ids: string[]) => void
    organizationIds?: string[]
    groupIds?: string[]
    branchIds?: string[]
    placeholder?: string
    disabled?: boolean
}

export function UserFilter({ 
    selectedIds, 
    onChange, 
    organizationIds, 
    groupIds, 
    branchIds, 
    placeholder = "Select Users", 
    disabled = false 
}: Readonly<UserFilterProps>) {
    const params = new URLSearchParams()
    if (organizationIds?.length) params.set("organizationIds", organizationIds.join(","))
    if (groupIds?.length) params.set("groupIds", groupIds.join(","))
    if (branchIds?.length) params.set("branchIds", branchIds.join(","))

    const { data, isLoading } = useSWR(
        `/api/v1/analytics/users/list?${params.toString()}`,
        fetcher,
        { revalidateOnFocus: false }
    )

    const users = (data?.items || []) as User[]
    
    // Create map to count occurrences of names to identify duplicates
    const nameCounts = new Map<string, number>()
    users.forEach(u => nameCounts.set(u.name, (nameCounts.get(u.name) || 0) + 1))

    const items = users.map((u: User) => {
        let label = u.name
        const isDuplicate = nameCounts.get(u.name)! > 1

        if (u.employeeId) {
            label = `${u.name} (${u.employeeId})`
        } else if (isDuplicate) {
            // Append short ID if no employee ID and name is duplicate
            label = `${u.name} [${u.id.split('-')[0]}]`
        }

        return { id: u.id, label }
    })

    return (
        <MultiSelectFilter
            title="Users"
            items={items}
            selectedIds={selectedIds}
            onChange={onChange}
            disabled={disabled || isLoading}
            icon={<UserCircle size={16} className={cn((selectedIds.length > 0 || disabled) ? "text-indigo-600" : "text-slate-400", "shrink-0")} />}
            placeholder={isLoading ? "Loading..." : placeholder}
            className="w-[280px]"
        />
    )
}
