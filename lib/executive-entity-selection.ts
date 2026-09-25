/**
 * Keeping a picked comparison honest when the filters beneath it move.
 *
 * The entity pickers on Product Performance hold keys — requester ids, product
 * ids — that were offered for one filter set. Change the branch and the server
 * answers the options endpoint with a different list, but the keys already
 * ticked survive in component state: the screen then narrows every panel to
 * people who raised nothing at the branch on screen, and each panel draws an
 * empty chart while the trigger still claims "2 of 14 people" from a list that
 * no longer contains either of them.
 *
 * So a selection is read back through the list it was offered from. This is the
 * whole rule, and it is pure so the drop is stated once rather than re-derived
 * by each reader of the selection.
 *
 * It is deliberately *not* a security control — the options endpoint already
 * fences its list to the caller's branch set, and every comparison endpoint
 * re-fences the ids it is sent. Dropping a key here only spares the reader a
 * chart that would have come back empty.
 */

/**
 * The picked keys that the current option list still offers, in the order they
 * were picked.
 *
 * Returns `selected` itself when every key survives, so a caller may compare by
 * identity to tell whether anything was dropped — and so a memo or an effect
 * keyed on the result does not fire on every render against a freshly built
 * option array.
 */
export function retainAvailable(
  selected: string[],
  options: ReadonlyArray<{ key: string }>,
): string[] {
  if (selected.length === 0) return selected

  const available = new Set(options.map((option) => option.key))
  const kept = selected.filter((key) => available.has(key))
  return kept.length === selected.length ? selected : kept
}
