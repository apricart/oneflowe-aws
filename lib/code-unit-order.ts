/**
 * Compare two strings by UTF-16 code unit: exactly the order
 * `Array.prototype.sort()` uses when given no compare function, made explicit.
 *
 * Use it wherever an order must be identical on every machine — the plan
 * digests the K-Electric scripts print and then require on commit, canonical
 * JSON, report keys. `localeCompare` is the wrong tool there: its order depends
 * on the host's ICU data and folds case and punctuation that this order keeps,
 * so swapping it in would change every digest a past run recorded.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
