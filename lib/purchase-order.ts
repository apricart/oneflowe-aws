/**
 * The buyer's own purchase order reference, captured against the order.
 *
 * One definition shared by the request schemas and by every form that offers
 * the field, so what a portal lets a user type is exactly what the server
 * accepts. Free text would be carried onto a PDF, an HTML invoice, and a
 * spreadsheet export, so the alphabet is restricted to what a purchase order
 * reference actually uses.
 */

/** Width of `orders.po_number` and `group_orders.po_number`. */
export const MAX_PO_NUMBER_LENGTH = 64

/** Letters, digits, space and the separators a PO reference uses. Linear — no nested quantifiers. */
export const PO_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._/#-]*$/

export const PO_NUMBER_HINT = "Letters, numbers, spaces, and - _ . / # only"

export const PO_NUMBER_MESSAGE =
  `Purchase order number may use letters, numbers, spaces, and - _ . / # only`

/**
 * What a form should keep as the user types: disallowed characters dropped, a
 * leading separator dropped, and the stored width respected. Typing is
 * corrected here so a valid-looking entry is never refused at submission; the
 * server re-validates the result regardless.
 */
export function normalizePoNumberInput(value: string): string {
  return value
    .replace(/[^A-Za-z0-9 ._/#-]/g, "")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, MAX_PO_NUMBER_LENGTH)
}
