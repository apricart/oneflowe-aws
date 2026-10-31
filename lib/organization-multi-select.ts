/**
 * Selection rules for the searchable organization multi-select
 * (`components/finance/organization-multi-select.tsx`). Presentation only: the
 * server validates every organization id it is sent. The rules themselves are
 * the generic ones in `lib/multi-select.ts`.
 */

import {
  clearVisible,
  everyVisibleSelected,
  filterOptions,
  selectVisible,
  selectionLabel,
  toggleValue,
  type MultiSelectOption,
} from "@/lib/multi-select"

export type OrganizationOption = MultiSelectOption<number>

/** The options whose name or keywords contain every word of the query, case-insensitively. */
export function filterOrganizationOptions<T extends OrganizationOption>(options: readonly T[], query: string): T[] {
  return filterOptions(options, query)
}

/** Adds the id when absent, removes it when present. */
export function toggleOrganization(selected: readonly number[], id: number): number[] {
  return toggleValue(selected, id)
}

/** Adds every visible option to the selection, keeping what was already chosen. */
export function selectVisibleOrganizations(selected: readonly number[], visible: readonly OrganizationOption[]): number[] {
  return selectVisible(selected, visible)
}

/** Removes every visible option from the selection, keeping the rest. */
export function clearVisibleOrganizations(selected: readonly number[], visible: readonly OrganizationOption[]): number[] {
  return clearVisible(selected, visible)
}

/** Whether every visible option is selected (false when nothing is visible). */
export function allVisibleSelected(selected: readonly number[], visible: readonly OrganizationOption[]): boolean {
  return everyVisibleSelected(selected, visible)
}

/** The trigger's text: the placeholder, one name, or a count. */
export function organizationSelectionLabel(
  selected: readonly number[],
  options: readonly OrganizationOption[],
  placeholder: string,
): string {
  return selectionLabel(selected, options, placeholder, { one: "organization", many: "organizations" })
}
