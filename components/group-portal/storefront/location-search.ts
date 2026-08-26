import type { ScopedBranch, ScopedGroup } from "../types"

/**
 * How many locations a search will show at once.
 *
 * A requester assigned dozens of groups can match hundreds of locations with
 * two letters, and a sidebar that long is not a list anyone reads. The count
 * that was cut is reported to the caller so the truncation is stated rather
 * than silently dropping locations the user asked to see.
 */
export const MAX_LOCATION_MATCHES = 50

/** Matching locations from one group, in the order the group lists them. */
export type LocationMatchGroup = {
  groupId: number | null
  groupName: string
  branches: ScopedBranch[]
}

export type LocationSearchResult = {
  /** Matching groups in the order they were assigned; empty for a blank query. */
  groups: LocationMatchGroup[]
  /** Locations actually listed, after the cap. */
  matchCount: number
  /** True when the cap left matches out. */
  truncated: boolean
}

const EMPTY_RESULT: LocationSearchResult = { groups: [], matchCount: 0, truncated: false }

function contains(field: string | null | undefined, needle: string): boolean {
  return typeof field === "string" && field.toLowerCase().includes(needle)
}

/**
 * Every location this user can order for, across every group, that matches a
 * free-text query.
 *
 * A location matches on its name, its city, or its cost centre — the three
 * things a requester actually knows a branch by. Naming a *group* matches all
 * of its locations, so someone who remembers the group but not the branch is
 * not told "no results".
 *
 * The result stays grouped rather than flattening into one list, and that is
 * deliberate: locations belong to one group at a time in an order, so a search
 * that presented them as a single pool would suggest a selection the server
 * would never accept. Ticking a result still goes through the ordinary
 * selection path, which moves the whole selection to that location's group.
 *
 * A blank query returns nothing rather than everything: the caller shows its
 * normal group tree in that case, and returning the full list would have it
 * render the same locations twice.
 */
export function searchLocations(groups: ScopedGroup[], query: string): LocationSearchResult {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return EMPTY_RESULT

  const all: LocationMatchGroup[] = []
  let total = 0

  for (const group of groups) {
    const groupMatches = contains(group.name, needle)
    const branches = group.branches.filter(
      (branch) =>
        groupMatches ||
        contains(branch.name, needle) ||
        contains(branch.city, needle) ||
        contains(branch.costCenterId, needle),
    )
    if (branches.length === 0) continue

    total += branches.length
    all.push({ groupId: group.id, groupName: group.name, branches })
  }

  if (total <= MAX_LOCATION_MATCHES) {
    return { groups: all, matchCount: total, truncated: false }
  }

  // Cut from the end, so the groups nearest the top of the sidebar are the ones
  // that survive and the list a requester scrolls stays in a familiar order.
  const capped: LocationMatchGroup[] = []
  let remaining = MAX_LOCATION_MATCHES
  for (const match of all) {
    if (remaining === 0) break
    const branches = match.branches.slice(0, remaining)
    remaining -= branches.length
    capped.push({ ...match, branches })
  }

  return { groups: capped, matchCount: MAX_LOCATION_MATCHES, truncated: true }
}
