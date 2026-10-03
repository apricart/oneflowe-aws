/**
 * Column sorting shared by the Orders table and every report table
 * (`plans/OF-TABLE-column-sorting.md`). Pure: the client sorts fully loaded
 * tables with `sortRows`, and the paginated endpoints read the requested sort
 * with `parseSortParams` before mapping it to SQL.
 */

export type SortDirection = "asc" | "desc"

export type SortState<K extends string> = { key: K; direction: SortDirection } | null

export type SortValue = string | number | Date | boolean | null | undefined

/**
 * Clicking the sorted column flips it; clicking another starts that column at
 * its own first direction — A→Z for text, high→low for numbers and dates.
 */
export function nextSortState<K extends string>(
  current: SortState<K>,
  key: K,
  firstDirection: SortDirection = "asc",
): SortState<K> {
  if (current?.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" }
  }
  return { key, direction: firstDirection }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

function normalizeSortValue(value: SortValue): string | number | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isNaN(time) ? null : time
  }
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  const text = value.trim()
  return text === "" ? null : text
}

/**
 * Natural, case-insensitive order ("Branch 2" before "Branch 10"). Blanks sort
 * last in both directions, so reversing a column never buries the real rows
 * under the empty ones.
 */
export function compareSortValues(a: SortValue, b: SortValue, direction: SortDirection): number {
  const left = normalizeSortValue(a)
  const right = normalizeSortValue(b)
  if (left === null || right === null) {
    if (left === right) return 0
    return left === null ? 1 : -1
  }
  const base = typeof left === "number" && typeof right === "number"
    ? left - right
    : collator.compare(String(left), String(right))
  return direction === "asc" ? base : -base
}

/** Stable: rows that compare equal keep the order the server sent them in. */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  sort: SortState<K>,
  accessors: Readonly<Record<K, (row: T) => SortValue>>,
): T[] {
  if (!sort) return [...rows]
  const read = accessors[sort.key]
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => compareSortValues(read(a.row), read(b.row), sort.direction) || a.index - b.index)
    .map((entry) => entry.row)
}

export type ParsedSort<K extends string> =
  | { ok: true; sort: SortState<K> }
  | { ok: false; error: string }

/**
 * Reads `sort` and `dir` from a request. The key must be one of the endpoint's
 * allowlisted keys, so no request text ever reaches an ORDER BY. No `sort` at
 * all means "the endpoint's default order".
 */
export function parseSortParams<K extends string>(
  searchParams: URLSearchParams,
  keys: readonly K[],
): ParsedSort<K> {
  const key = searchParams.get("sort")
  const direction = searchParams.get("dir")
  if (key === null || key === "") return { ok: true, sort: null }
  if (!(keys as readonly string[]).includes(key)) return { ok: false, error: "Invalid sort column" }
  if (direction !== null && direction !== "asc" && direction !== "desc") {
    return { ok: false, error: "Invalid sort direction" }
  }
  return { ok: true, sort: { key: key as K, direction: direction ?? "desc" } }
}

/** Adds the sort to a request's query string; a null sort adds nothing. */
export function appendSortParams(params: URLSearchParams, sort: SortState<string>): void {
  if (!sort) return
  params.set("sort", sort.key)
  params.set("dir", sort.direction)
}
