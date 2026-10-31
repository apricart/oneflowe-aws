/**
 * Selection rules for a searchable multi-select with Select all and Clear,
 * which act on the options the search currently shows. Presentation only:
 * the server validates every id it is sent.
 */

export type MultiSelectOption<Id extends string | number = number> = {
  id: Id
  label: string
  /** Extra searchable text, such as an organization's short code. */
  keywords?: string | null
}

/** The options whose label or keywords contain every word of the query, case-insensitively. */
export function filterOptions<T extends { label: string; keywords?: string | null }>(options: readonly T[], query: string): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...options]
  return options.filter((option) => {
    const haystack = `${option.label} ${option.keywords ?? ""}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

/** Adds the id when absent, removes it when present. */
export function toggleValue<Id>(selected: readonly Id[], id: Id): Id[] {
  return selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]
}

/** Adds every visible option to the selection, keeping what was already chosen. */
export function selectVisible<Id>(selected: readonly Id[], visible: ReadonlyArray<{ id: Id }>): Id[] {
  const next = new Set(selected)
  for (const option of visible) next.add(option.id)
  return [...next]
}

/** Removes every visible option from the selection, keeping the rest. */
export function clearVisible<Id>(selected: readonly Id[], visible: ReadonlyArray<{ id: Id }>): Id[] {
  const hidden = new Set(visible.map((option) => option.id))
  return selected.filter((id) => !hidden.has(id))
}

/** Whether every visible option is selected (false when nothing is visible). */
export function everyVisibleSelected<Id>(selected: readonly Id[], visible: ReadonlyArray<{ id: Id }>): boolean {
  if (visible.length === 0) return false
  const chosen = new Set(selected)
  return visible.every((option) => chosen.has(option.id))
}

/** The trigger's text: the placeholder, one label, "All …", or a count. */
export function selectionLabel<Id>(
  selected: readonly Id[],
  options: ReadonlyArray<{ id: Id; label: string }>,
  placeholder: string,
  nouns: { one: string; many: string },
): string {
  if (selected.length === 0) return placeholder
  if (options.length > 0 && selected.length === options.length && options.every((option) => selected.includes(option.id))) {
    return `All ${nouns.many} (${options.length})`
  }
  if (selected.length === 1) {
    return options.find((option) => option.id === selected[0])?.label ?? `1 ${nouns.one}`
  }
  return `${selected.length} ${nouns.many}`
}
