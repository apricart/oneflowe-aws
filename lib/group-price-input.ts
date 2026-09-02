import { MAX_PRICE_CENTS } from "@/lib/price-ladder"

/**
 * Turning what an administrator types into the integer the ledger stores.
 *
 * Kept out of the dialog component so it can be tested directly: this is the
 * one place a mistyped price becomes a real price, and floating point is
 * involved. Every amount reaches the API as integer cents — the browser never
 * sends a float and the server never multiplies one.
 */

/** An amount the form will not accept, and why the row is flagged. */
export type PriceInputError = "malformed" | "too-large"

export type PriceInputResult =
  | { ok: true; cents: number }
  /** The box was left empty: clear the override and inherit the tier above. */
  | { ok: true; cents: null }
  | { ok: false; error: PriceInputError }

/** Rupees, with at most two decimal places. Nothing else is an amount. */
const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/

/**
 * Parse a typed amount into cents.
 *
 * An empty box is a valid input meaning "no group price", which is how an
 * override is cleared — distinct from a malformed entry, which must be
 * reported rather than silently treated as a clear.
 */
export function parsePriceInput(input: string): PriceInputResult {
  const trimmed = input.trim()
  if (trimmed === "") return { ok: true, cents: null }
  if (!AMOUNT_PATTERN.test(trimmed)) return { ok: false, error: "malformed" }

  // Rounded rather than truncated, and only ever applied to a value the pattern
  // above has already limited to two decimals, so 12.35 cannot land on 1234.
  const cents = Math.round(Number(trimmed) * 100)
  if (!Number.isSafeInteger(cents)) return { ok: false, error: "too-large" }
  if (cents > MAX_PRICE_CENTS) return { ok: false, error: "too-large" }

  return { ok: true, cents }
}

/** True when the box holds something that is neither an amount nor empty. */
export function isPriceInputInvalid(input: string): boolean {
  return !parsePriceInput(input).ok
}

/** Render stored cents back into the form. Null renders as an empty box. */
export function formatPriceInput(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2)
}

/**
 * Whether a row has actually been edited.
 *
 * Compared as normalized text so re-typing the value already stored is not
 * counted as a change — the endpoint should not be asked to rewrite a price
 * nobody altered, and the audit log should not record one.
 */
export function hasPriceChanged(input: string, storedCents: number | null): boolean {
  return input.trim() !== formatPriceInput(storedCents).trim()
}
