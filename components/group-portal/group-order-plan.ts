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

/**
 * Mirrors of the submission bounds enforced by the API.
 *
 * The source of truth is `lib/server/mutation-validation.ts`
 * (`MAX_GROUP_ORDER_ENTRIES`, `MAX_GROUP_ORDER_BRANCHES`); client code does not
 * import from `lib/server`, so they are restated here. They are used only to
 * keep the workspace from building a payload the server would have to reject
 * outright — the server still enforces its own limits.
 */
export const MAX_ENTRIES = 50
export const MAX_ENTRY_BRANCHES = 100

/**
 * Change one product's quantity on the merged per-branch view.
 *
 * `branchId` scopes the change to a single branch; omitting it applies the
 * quantity to every branch that already receives the product — never to a
 * branch that does not, because that would silently order something nobody
 * asked for. A quantity of zero drops the line, and a branch left with no lines
 * drops out of the order entirely rather than becoming an empty order.
 */
export function applyQuantityToBranchPlans(
  plans: BranchPlan[],
  organizationInventoryId: number,
  quantity: number,
  branchId?: number,
): BranchPlan[] {
  const next = roundQuantity(quantity)

  return plans.flatMap((plan): BranchPlan[] => {
    if (branchId !== undefined && plan.branch.id !== branchId) return [plan]
    if (!plan.lines.some((line) => line.organizationInventoryId === organizationInventoryId)) {
      return [plan]
    }

    const lines = next > 0
      ? plan.lines.map((line) => line.organizationInventoryId === organizationInventoryId
        ? { ...line, quantity: next }
        : line)
      : plan.lines.filter((line) => line.organizationInventoryId !== organizationInventoryId)

    if (lines.length === 0) return []

    return [{
      ...plan,
      lines,
      totalCents: lines.reduce(
        (sum, line) => sum + calculateLineCents(line.priceCents, line.quantity),
        0,
      ),
    }]
  })
}

/**
 * Replace what one branch receives with an edited set of lines.
 *
 * This is how a product is added to a single location on the review screen:
 * the location's lines are edited as a whole and swapped in, and every other
 * branch keeps exactly what it had. Lines at zero are dropped, a product named
 * twice keeps its last quantity, and a branch left with nothing drops out — the
 * same rules as a quantity edit. A branch not already in the order is left out
 * rather than added, because which locations are ordered for is chosen in the
 * sidebar, not here.
 */
export function replaceBranchPlanLines(
  plans: BranchPlan[],
  branchId: number,
  lines: SelectedLine[],
): BranchPlan[] {
  const byInventoryId = new Map<number, SelectedLine>()
  for (const line of lines) {
    const quantity = roundQuantity(line.quantity)
    if (quantity > 0) byInventoryId.set(line.organizationInventoryId, { ...line, quantity })
  }
  const nextLines = [...byInventoryId.values()].sort((left, right) => left.name.localeCompare(right.name))

  return plans.flatMap((plan): BranchPlan[] => {
    if (plan.branch.id !== branchId) return [plan]
    if (nextLines.length === 0) return []
    return [{
      ...plan,
      lines: nextLines,
      totalCents: entryTotalCents(nextLines),
    }]
  })
}

/** Every branch except the one named, which leaves the group order. */
export function withoutBranchPlan(plans: BranchPlan[], branchId: number): BranchPlan[] {
  return plans.filter((plan) => plan.branch.id !== branchId)
}

/**
 * Rebuild the entry list from an edited set of branch plans.
 *
 * Entries are how the order is *built* (these branches, these items) and plans
 * are what each branch *receives*. Once a quantity is adjusted for one branch,
 * the entries that produced it no longer describe the order, so they are
 * rewritten from the plans instead of patched: branches receiving exactly the
 * same lines share one entry, which keeps the payload well inside the server's
 * entry limit and makes `mergeEntriesIntoBranchPlans` reproduce these plans
 * exactly. Branch lists are chunked so no single entry exceeds the server's
 * per-entry branch limit.
 */
export function branchPlansToEntries(
  plans: BranchPlan[],
  nextKey: () => string,
): GroupOrderEntry[] {
  const byContent = new Map<string, { lines: SelectedLine[]; branchIds: number[] }>()

  for (const plan of plans) {
    if (plan.lines.length === 0) continue
    const lines = [...plan.lines].sort(
      (left, right) => left.organizationInventoryId - right.organizationInventoryId,
    )
    const signature = lines
      .map((line) => `${line.organizationInventoryId}:${roundQuantity(line.quantity)}`)
      .join("|")

    const bucket = byContent.get(signature)
    if (bucket) {
      bucket.branchIds.push(plan.branch.id)
      continue
    }
    byContent.set(signature, { lines, branchIds: [plan.branch.id] })
  }

  return [...byContent.values()].flatMap(({ lines, branchIds }) => {
    const chunks: number[][] = []
    for (let index = 0; index < branchIds.length; index += MAX_ENTRY_BRANCHES) {
      chunks.push(branchIds.slice(index, index + MAX_ENTRY_BRANCHES))
    }
    return chunks.map((ids) => ({ key: nextKey(), branchIds: ids, lines }))
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
