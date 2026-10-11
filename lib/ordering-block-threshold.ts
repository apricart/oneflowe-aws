/**
 * How many unpaid invoices, or delivered-but-unacknowledged orders, stop a
 * branch ordering — set per organization by Super Admin
 * (plans/OF-ORDERING-BLOCK-configurable-thresholds.md).
 *
 * Pure. The bounds and the default live here and nowhere else: the Zod
 * schemas, both gates, the Company form and the database CHECK constraints
 * (`organizations_*_block_threshold_ck`) all hold these numbers.
 */

/**
 * The lowest threshold. Zero would block every branch with nothing
 * outstanding; a tenant that should not be blocked switches the block off.
 */
export const ORDERING_BLOCK_THRESHOLD_MIN = 1

/** The highest threshold. A bound, not a business figure. */
export const ORDERING_BLOCK_THRESHOLD_MAX = 100

/** The fixed value before the threshold was configurable, and the column default. */
export const DEFAULT_ORDERING_BLOCK_THRESHOLD = 2

export function isOrderingBlockThreshold(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= ORDERING_BLOCK_THRESHOLD_MIN
    && value <= ORDERING_BLOCK_THRESHOLD_MAX
}

/**
 * The threshold a gate applies. A value outside the bounds — unreachable
 * behind the CHECK constraint, but a gate must never fail open — falls back to
 * the default rather than to "never block".
 */
export function orderingBlockThresholdOrDefault(value: unknown): number {
  return isOrderingBlockThreshold(value) ? value : DEFAULT_ORDERING_BLOCK_THRESHOLD
}

export const ORDERING_BLOCK_THRESHOLD_RANGE_MESSAGE =
  `Enter a whole number from ${ORDERING_BLOCK_THRESHOLD_MIN} to ${ORDERING_BLOCK_THRESHOLD_MAX}.`

export type OrderingBlockThresholdDraft =
  | { ok: true; value: number }
  | { ok: false; message: string }

/**
 * What the Company form's number field holds. Digits only: a sign, a decimal
 * point, an exponent or a blank is refused rather than coerced, so "1e1" is
 * never quietly read as 10.
 */
export function parseOrderingBlockThresholdDraft(text: string): OrderingBlockThresholdDraft {
  const trimmed = text.trim()
  if (!/^\d{1,6}$/.test(trimmed)) return { ok: false, message: ORDERING_BLOCK_THRESHOLD_RANGE_MESSAGE }
  const value = Number(trimmed)
  return isOrderingBlockThreshold(value)
    ? { ok: true, value }
    : { ok: false, message: ORDERING_BLOCK_THRESHOLD_RANGE_MESSAGE }
}

/** `audit_logs.action` when Super Admin changes the unpaid-invoice threshold. */
export const UNPAID_INVOICE_BLOCK_THRESHOLD_AUDIT_ACTION = "UPDATE_UNPAID_INVOICE_BLOCK_THRESHOLD"

/** `audit_logs.action` when Super Admin changes the unacknowledged-delivery threshold. */
export const UNACKNOWLEDGED_DELIVERY_BLOCK_THRESHOLD_AUDIT_ACTION = "UPDATE_UNACKNOWLEDGED_DELIVERY_BLOCK_THRESHOLD"
