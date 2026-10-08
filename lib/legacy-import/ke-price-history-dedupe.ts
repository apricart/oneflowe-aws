/**
 * Which K-Electric price-history rows to remove so the Product Price History
 * screen never lists the same price twice in a row for one product.
 *
 * The screen (`app/api/v1/admin/product-price-history/route.ts`) does not list
 * every ledger row. Over positive prices only, it keeps a derived row when the
 * previous row *in the same organization+group stream* has a different
 * positive price, and a CATALOG_CHANGE row when its own recorded previous price
 * differs. Because the streams are per group, Distribution at 195 followed by
 * Enabling at 195 are both "changes" and appear next to each other.
 *
 * Deleting a row moves the comparison point of the next row in its group, so
 * a naive "delete the second of each pair" also hides genuine changes. The
 * planner therefore searches, per product, over the ways of resolving each
 * duplicate pair — removing either row, or removing the row just before either
 * one in its own group (which hides it without touching anything else) — and
 * keeps the outcome that lists the most of today's rows with no neighbouring
 * duplicate, using the fewest deletions. The outcome only ever lists rows the
 * screen lists today.
 *
 * Only ORDER_BACKFILL and MIGRATION_BASELINE rows are ever chosen; live
 * CATALOG_CHANGE events are append-only. Zero-price rows are invisible to the
 * screen and are left alone. The ledger is display-only: no order, price or
 * budget reads it.
 */

export type PriceHistorySource = "CATALOG_CHANGE" | "ORDER_BACKFILL" | "MIGRATION_BASELINE"

export interface PriceHistoryRow {
  id: number
  globalProductId: number
  groupId: number | null
  priceCents: number
  previousPriceCents: number | null
  source: PriceHistorySource
  /** Position in the product's timeline: the screen's `changed_at, id` order. */
  seq: number
}

export interface PriceHistoryRemoval {
  globalProductId: number
  removedId: number
  priceCents: number
}

export interface PriceHistoryDedupePlan {
  removals: PriceHistoryRemoval[]
  /** Products whose duplicates could not all be removed (only catalogue edits involved). */
  unresolvedProductIds: number[]
}

/** Search states per product before the planner refuses rather than guess. */
export const MAX_SEARCH_STATES = 250_000

const isDerived = (row: PriceHistoryRow) => row.source !== "CATALOG_CHANGE"
const bySeq = (a: PriceHistoryRow, b: PriceHistoryRow) => a.seq - b.seq
const streamOf = (row: PriceHistoryRow) => String(row.groupId ?? -1)

/** The rows the screen lists for one product, oldest first. */
export function visiblePriceHistoryRows(rows: readonly PriceHistoryRow[]): PriceHistoryRow[] {
  const lastByStream = new Map<string, number>()
  const visible: PriceHistoryRow[] = []
  for (const row of rows.filter((r) => r.priceCents > 0).sort(bySeq)) {
    const previous = lastByStream.get(streamOf(row))
    const shown = isDerived(row)
      ? previous !== undefined && previous > 0 && previous !== row.priceCents
      : row.previousPriceCents !== null && row.previousPriceCents > 0 && row.previousPriceCents !== row.priceCents
    if (shown) visible.push(row)
    lastByStream.set(streamOf(row), row.priceCents)
  }
  return visible
}

function neighbouringDuplicates(visible: PriceHistoryRow[]): Array<[PriceHistoryRow, PriceHistoryRow]> {
  const pairs: Array<[PriceHistoryRow, PriceHistoryRow]> = []
  for (let i = 0; i + 1 < visible.length; i += 1) {
    if (visible[i].priceCents === visible[i + 1].priceCents) pairs.push([visible[i], visible[i + 1]])
  }
  return pairs
}

function streamPredecessor(live: PriceHistoryRow[], row: PriceHistoryRow): PriceHistoryRow | null {
  let previous: PriceHistoryRow | null = null
  for (const candidate of live) {
    if (candidate.priceCents <= 0 || streamOf(candidate) !== streamOf(row)) continue
    if (candidate.id === row.id) return previous
    previous = candidate
  }
  return null
}

interface Outcome { shown: number; removed: number[] }

const better = (a: Outcome, b: Outcome) =>
  a.shown !== b.shown ? a.shown > b.shown : a.removed.length < b.removed.length

function planProduct(rows: PriceHistoryRow[]): { removed: number[]; resolved: boolean } {
  const sorted = [...rows].sort(bySeq)
  const listedToday = new Set(visiblePriceHistoryRows(sorted).map((row) => row.id))
  const memo = new Map<string, Outcome>()
  let resolved = true

  const search = (removed: number[]): Outcome => {
    const memoKey = removed.join(",")
    const known = memo.get(memoKey)
    if (known) return known
    if (memo.size >= MAX_SEARCH_STATES) {
      throw new Error(`Price history search for product ${rows[0]?.globalProductId} exceeded ${MAX_SEARCH_STATES} states`)
    }

    const live = sorted.filter((row) => !removed.includes(row.id))
    const visible = visiblePriceHistoryRows(live)
    let pair: [PriceHistoryRow, PriceHistoryRow] | undefined
    let candidates: number[] = []
    for (const [first, second] of neighbouringDuplicates(visible)) {
      const options = new Set<number>()
      for (const row of [first, second]) {
        if (isDerived(row)) options.add(row.id)
        const predecessor = streamPredecessor(live, row)
        if (predecessor && isDerived(predecessor)) options.add(predecessor.id)
      }
      if (options.size > 0) { pair = [first, second]; candidates = [...options].sort((a, b) => a - b); break }
      resolved = false
    }

    let outcome: Outcome
    if (!pair) {
      const onlyTodaysRows = visible.every((row) => listedToday.has(row.id))
      outcome = { shown: onlyTodaysRows ? visible.length : -1, removed }
    } else {
      outcome = { shown: -1, removed }
      for (const id of candidates) {
        const next = search([...removed, id].sort((a, b) => a - b))
        if (outcome.shown === -1 || better(next, outcome)) outcome = next
      }
    }
    memo.set(memoKey, outcome)
    return outcome
  }

  const best = search([])
  return { removed: best.shown < 0 ? [] : best.removed, resolved: resolved && best.shown >= 0 }
}

/** Rows of one organization, every product. Pure: nothing is read or written. */
export function planPriceHistoryDedupe(rows: readonly PriceHistoryRow[]): PriceHistoryDedupePlan {
  const byProduct = new Map<number, PriceHistoryRow[]>()
  for (const row of rows) {
    const list = byProduct.get(row.globalProductId) ?? []
    list.push(row)
    byProduct.set(row.globalProductId, list)
  }
  const plan: PriceHistoryDedupePlan = { removals: [], unresolvedProductIds: [] }
  for (const productId of [...byProduct.keys()].sort((a, b) => a - b)) {
    const productRows = byProduct.get(productId) ?? []
    const priceById = new Map(productRows.map((row) => [row.id, row.priceCents]))
    const { removed, resolved } = planProduct(productRows)
    for (const id of removed) {
      plan.removals.push({ globalProductId: productId, removedId: id, priceCents: priceById.get(id) ?? 0 })
    }
    if (!resolved) plan.unresolvedProductIds.push(productId)
  }
  return plan
}
