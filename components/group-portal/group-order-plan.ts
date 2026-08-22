import { calculateLineCents, roundQuantity } from "@/lib/quantity"

import type { BranchPlan, GroupOrderEntry, ScopedBranch, SelectedLine } from "./types"

/**
 * The client-side mirror of the server's merge.
 *
 * A branch selected in several entries receives one order whose lines are the
 * summed quantities. The preview the user approves is therefore the same shape
 * the server will build — but the server recomputes it from its own copy of the
 * entries and re-prices every line, so this is a rendering aid and never an
 * input to the decision.
 */
export function mergeEntriesIntoBranchPlans(
  entries: GroupOrderEntry[],
  branchesById: Map<number, ScopedBranch>,
): BranchPlan[] {
  const linesByBranch = new Map<number, Map<number, SelectedLine>>()

  for (const entry of entries) {
    for (const branchId of entry.branchIds) {
      const lines = linesByBranch.get(branchId) ?? new Map<number, SelectedLine>()
      for (const line of entry.lines) {
        const existing = lines.get(line.organizationInventoryId)
        lines.set(line.organizationInventoryId, {
          ...line,
          quantity: roundQuantity((existing?.quantity ?? 0) + line.quantity),
        })
      }
      linesByBranch.set(branchId, lines)
    }
  }

  return [...linesByBranch.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([branchId, lines]) => {
      const branch = branchesById.get(branchId)
      if (!branch || lines.size === 0) return []
      const orderedLines = [...lines.values()].sort((left, right) => left.name.localeCompare(right.name))
      return [{
        branch,
        lines: orderedLines,
        totalCents: orderedLines.reduce(
          (sum, line) => sum + calculateLineCents(line.priceCents, line.quantity),
          0,
        ),
      }]
    })
}

export function entryTotalCents(lines: SelectedLine[]): number {
  return lines.reduce((sum, line) => sum + calculateLineCents(line.priceCents, line.quantity), 0)
}

/** Branches covered by at least one entry. */
export function coveredBranchIds(entries: GroupOrderEntry[]): number[] {
  return [...new Set(entries.flatMap((entry) => entry.branchIds))]
}

/** The payload shape the API accepts: selections only, no display fields. */
export function toRequestEntries(entries: GroupOrderEntry[]) {
  return entries.map((entry) => ({
    branchIds: entry.branchIds,
    items: entry.lines.map((line) => ({
      organizationInventoryId: line.organizationInventoryId,
      quantity: line.quantity,
    })),
  }))
}
