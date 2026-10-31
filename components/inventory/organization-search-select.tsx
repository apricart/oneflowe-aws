"use client"

import { DeskSearchableSelect } from "@/components/order-desk/desk-searchable-select"

export type OrganizationSearchOption = {
  id: number
  name: string
}

/**
 * The searchable organization picker on the inventory pages. Those pages hold
 * the choice as a string id ("" for none), so this adapts the shared searchable
 * select to that. Choosing only selects what to load — every endpoint scopes
 * the caller itself.
 */
export function OrganizationSearchSelect({
  value,
  organizations,
  placeholder,
  onValueChange,
}: Readonly<{
  value: string
  organizations: readonly OrganizationSearchOption[]
  placeholder: string
  onValueChange: (value: string) => void
}>) {
  const selected = Number.parseInt(value, 10)

  return (
    <div className="w-full max-w-md">
      <DeskSearchableSelect
        ariaLabel="Organization"
        value={Number.isFinite(selected) ? selected : null}
        options={organizations.map((org) => ({ id: org.id, label: org.name }))}
        placeholder={placeholder}
        searchLabel="Search organizations"
        emptyLabel="No organization found."
        onValueChange={(next) => onValueChange(next === null ? "" : next.toString())}
      />
    </div>
  )
}
