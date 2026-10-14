/**
 * Order approval levels — set per organization by Super Admin
 * (plans/OF-APPROVAL-LEVELS-organization-approval-levels.md).
 *
 * An organization with the feature on carries an ordered list of levels. Level
 * N's amount says that an order equal to or above it may be approved by a user
 * who holds Level N. Level 1 is the highest level and has the highest amount,
 * and every level after it must be lower than the one before: a level whose
 * threshold is no lower than the level above it would add nothing.
 *
 * The amount is stored as `max_amount_cents` / `maxAmountCents`, a name kept
 * from the first version of this feature, when the order ran the other way. It
 * is the level's threshold: the smallest order that level approves.
 *
 * Pure. The bounds live here and nowhere else: the Zod schema, the Company
 * form and the database checks on `organization_approval_levels` all hold
 * these numbers. Amounts are integer cents throughout; nothing here does
 * floating-point arithmetic on money.
 */

/**
 * The most levels an organization may define. A bound, not a business figure:
 * it keeps the form usable and the request far below the WAF's 8 KB body limit.
 * Mirrored by `organization_approval_levels_level_ck`.
 */
export const MAX_APPROVAL_LEVELS = 10

/** The smallest amount a level may carry: one paisa. */
export const APPROVAL_LEVEL_MIN_AMOUNT_CENTS = 1

/**
 * The largest amount a level may carry: PKR 1,000,000,000.00. Comfortably
 * inside `Number.MAX_SAFE_INTEGER`, so a cents value never loses precision in
 * JavaScript. Mirrored by `organization_approval_levels_amount_ck`.
 */
export const APPROVAL_LEVEL_MAX_AMOUNT_CENTS = 100_000_000_000

/** `audit_logs.action` when Super Admin changes an organization's levels. */
export const ORDER_APPROVAL_LEVELS_AUDIT_ACTION = "UPDATE_ORDER_APPROVAL_LEVELS"

/** One stored level. */
export type ApprovalLevel = {
  level: number
  maxAmountCents: number
}

/** The whole configuration, as the endpoints read and write it. */
export type ApprovalLevelsState = {
  enabled: boolean
  levels: ApprovalLevel[]
}

export function isApprovalLevelAmountCents(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= APPROVAL_LEVEL_MIN_AMOUNT_CENTS
    && value <= APPROVAL_LEVEL_MAX_AMOUNT_CENTS
}

// Whole rupees only; the paisa are appended from the integer remainder, so no
// money value is ever carried as a fractional float.
const GROUPED_WHOLE_RUPEES = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })

function splitCents(cents: number): { whole: number; paisa: string } {
  return { whole: Math.floor(cents / 100), paisa: String(cents % 100).padStart(2, "0") }
}

/** "PKR 40,000.00" — for labels, hints and messages, never for an input. */
export function formatApprovalLevelAmount(cents: number): string {
  const { whole, paisa } = splitCents(cents)
  return `PKR ${GROUPED_WHOLE_RUPEES.format(whole)}.${paisa}`
}

/** What the amount field shows for a stored value: "40000", or "40000.50". */
export function approvalLevelAmountText(cents: number): string {
  const { whole, paisa } = splitCents(cents)
  return paisa === "00" ? String(whole) : `${whole}.${paisa}`
}

export type ApprovalLevelAmountDraft =
  | { ok: true; cents: number }
  | { ok: false; message: string }

export const APPROVAL_LEVEL_AMOUNT_FORMAT_MESSAGE =
  "Enter an amount in rupees, such as 40000 or 40,000.50."

export const APPROVAL_LEVEL_AMOUNT_RANGE_MESSAGE =
  `Enter an amount above zero and at most ${formatApprovalLevelAmount(APPROVAL_LEVEL_MAX_AMOUNT_CENTS)}.`

// Digits, optionally grouped in threes with commas, then at most two decimals.
// A sign, an exponent, a stray comma or a third decimal is refused rather than
// coerced, so "1e5" is never quietly read as 100,000.
const AMOUNT_PATTERN = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/

/**
 * What an amount field holds, as cents. Worked out from the digits as text, so
 * "0.29" is 29 cents exactly rather than whatever 0.29 * 100 rounds to.
 */
export function parseApprovalLevelAmountDraft(text: string): ApprovalLevelAmountDraft {
  const match = AMOUNT_PATTERN.exec(text.trim())
  if (!match) return { ok: false, message: APPROVAL_LEVEL_AMOUNT_FORMAT_MESSAGE }

  const wholeDigits = match[1].replaceAll(",", "")
  // Longer than the maximum's whole part can only be out of range, and is
  // refused before it becomes a number too large to hold exactly.
  if (wholeDigits.replace(/^0+/, "").length > 10) {
    return { ok: false, message: APPROVAL_LEVEL_AMOUNT_RANGE_MESSAGE }
  }

  const cents = Number(wholeDigits) * 100 + Number((match[2] ?? "").padEnd(2, "0"))
  return isApprovalLevelAmountCents(cents)
    ? { ok: true, cents }
    : { ok: false, message: APPROVAL_LEVEL_AMOUNT_RANGE_MESSAGE }
}

export const APPROVAL_LEVELS_REQUIRED_MESSAGE =
  "Add at least one approval level before turning approval levels on."

export const APPROVAL_LEVELS_TOO_MANY_MESSAGE =
  `An organization can have at most ${MAX_APPROVAL_LEVELS} approval levels.`

function notLowerMessage(level: number, previousCents: number): string {
  return `Level ${level}'s amount must be lower than Level ${level - 1}'s (${formatApprovalLevelAmount(previousCents)}).`
}

/**
 * Why a list of level amounts cannot be saved, or null when it can. The one
 * statement of the rule: the Zod schema runs it on every request and the form
 * runs it on every keystroke, so the two can never disagree.
 *
 * `amountsCents[0]` is Level 1.
 */
export function approvalLevelsError(
  enabled: boolean,
  amountsCents: readonly number[],
): string | null {
  if (enabled && amountsCents.length === 0) return APPROVAL_LEVELS_REQUIRED_MESSAGE
  if (amountsCents.length > MAX_APPROVAL_LEVELS) return APPROVAL_LEVELS_TOO_MANY_MESSAGE

  for (let index = 0; index < amountsCents.length; index += 1) {
    const cents = amountsCents[index]
    if (!isApprovalLevelAmountCents(cents)) {
      return `Level ${index + 1}: ${APPROVAL_LEVEL_AMOUNT_RANGE_MESSAGE}`
    }
    if (index > 0 && cents >= amountsCents[index - 1]) {
      return notLowerMessage(index + 1, amountsCents[index - 1])
    }
  }
  return null
}

/** Stored levels in level order, numbered from their position. */
export function toApprovalLevels(amountsCents: readonly number[]): ApprovalLevel[] {
  return amountsCents.map((maxAmountCents, index) => ({ level: index + 1, maxAmountCents }))
}

/**
 * Whether a save would change anything. An unchanged save writes no rows and
 * no audit entry. `nextAmountsCents` undefined means "leave the levels alone",
 * which is what a save with the feature switched off sends.
 */
export function approvalLevelsChanged(
  current: ApprovalLevelsState,
  next: { enabled: boolean; amountsCents?: readonly number[] },
): boolean {
  if (current.enabled !== next.enabled) return true
  if (next.amountsCents === undefined) return false
  if (current.levels.length !== next.amountsCents.length) return true
  return current.levels.some((level, index) => level.maxAmountCents !== next.amountsCents?.[index])
}

/* ── The Company form's drafts ───────────────────────────────────────────── */

/**
 * Per-level problems for the form, one entry per draft, null where the level
 * is fine. A level is judged on its own text first, then against the level
 * before it once both parse.
 */
export function approvalLevelDraftErrors(drafts: readonly string[]): (string | null)[] {
  const parsed = drafts.map(parseApprovalLevelAmountDraft)
  return parsed.map((draft, index) => {
    if (!draft.ok) return draft.message
    const previous = index > 0 ? parsed[index - 1] : null
    if (previous?.ok && draft.cents >= previous.cents) {
      return notLowerMessage(index + 1, previous.cents)
    }
    return null
  })
}

/**
 * Why the section cannot be saved, or null. Switched off, there is nothing to
 * check: the drafts are not sent, and the stored levels are kept.
 */
export function approvalLevelDraftsError(enabled: boolean, drafts: readonly string[]): string | null {
  if (!enabled) return null
  if (drafts.length === 0) return APPROVAL_LEVELS_REQUIRED_MESSAGE
  if (drafts.length > MAX_APPROVAL_LEVELS) return APPROVAL_LEVELS_TOO_MANY_MESSAGE
  return approvalLevelDraftErrors(drafts).some((problem) => problem !== null)
    ? "Fix the approval level amounts before saving."
    : null
}

export type ApprovalLevelsPayload = {
  enabled: boolean
  levels?: { maxAmountCents: number }[]
}

/**
 * The request body for the section. Switched off, `levels` is omitted so the
 * server keeps whatever is stored and switching back on restores it. Only call
 * this once `approvalLevelDraftsError` is null.
 */
export function toApprovalLevelsPayload(enabled: boolean, drafts: readonly string[]): ApprovalLevelsPayload {
  if (!enabled) return { enabled: false }
  return {
    enabled: true,
    levels: drafts.map((text) => {
      const draft = parseApprovalLevelAmountDraft(text)
      if (!draft.ok) throw new Error("toApprovalLevelsPayload called with an invalid draft")
      return { maxAmountCents: draft.cents }
    }),
  }
}
