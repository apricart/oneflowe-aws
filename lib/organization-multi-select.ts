/**
 * Selection rules for the searchable organization multi-select
 * (`components/finance/organization-multi-select.tsx`). Presentation only: the
 * server validates every organization id it is sent.
 */

export type OrganizationOption = {
  id: number
  label: string
  /** Extra searchable text, such as the organization's short code. */
  keywords?: string | null
}

/** The options whose name or keywords contain every word of the query, case-insensitively. */
export function filterOrganizationOptions<T extends OrganizationOption>(options: readonly T[], query: string): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...options]
  return options.filter((option) => {
    const haystack = `${option.label} ${option.keywords ?? ""}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

/** Adds the id when absent, removes it when present. */
export function toggleOrganization(selected: readonly number[], id: number): number[] {
  return selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]
}

/** Adds every visible option to the selection, keeping what was already chosen. */
export function selectVisibleOrganizations(selected: readonly number[], visible: readonly OrganizationOption[]): number[] {
  const next = new Set(selected)
  for (const option of visible) next.add(option.id)
  return [...next]
}

/** Removes every visible option from the selection, keeping the rest. */
export function clearVisibleOrganizations(selected: readonly number[], visible: readonly OrganizationOption[]): number[] {
  const hidden = new Set(visible.map((option) => option.id))
  return selected.filter((id) => !hidden.has(id))
}

/** Whether every visible option is selected (false when nothing is visible). */
export function allVisibleSelected(selected: readonly number[], visible: readonly OrganizationOption[]): boolean {
  if (visible.length === 0) return false
  const chosen = new Set(selected)
  return visible.every((option) => chosen.has(option.id))
}

/** The trigger's text: the placeholder, one name, or a count. */
export function organizationSelectionLabel(
  selected: readonly number[],
  options: readonly OrganizationOption[],
  placeholder: string,
): string {
  if (selected.length === 0) return placeholder
  if (options.length > 0 && selected.length === options.length && options.every((option) => selected.includes(option.id))) {
    return `All organizations (${options.length})`
  }
  if (selected.length === 1) {
    return options.find((option) => option.id === selected[0])?.label ?? "1 organization"
  }
  return `${selected.length} organizations`
}
