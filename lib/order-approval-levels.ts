/**
 * Order approval levels — set per organization by Super Admin
 * (plans/OF-APPROVAL-LEVELS-organization-approval-levels.md).
 *
 * An organization with the feature on carries an ordered list of levels, each
 * approving one band of order amounts — `approvalLevelBands` is the rule. Level
 * 1 is the highest and approves orders equal to or above its amount. Every
 * later level approves orders equal to or above its own amount and below the
 * amount of the level before it. The lowest level has no level below it, so it
 * also approves every order below its own amount. Each level's amount must be
 * lower than the one before, so the bands never overlap and leave no gap.
 *
 * The amount is stored as `max_amount_cents` / `maxAmountCents`, a name kept
 * from the first version of this feature, when the order ran the other way. It
 * is the level's threshold: the smallest order that level approves (except for
 * the lowest level, whose band reaches down to zero).
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
 * The orders one level approves: equal to or above `fromCents` and below
 * `belowCents`. A null bound is open — `fromCents` null reaches down to zero,
 * `belowCents` null has no ceiling.
 */
export type ApprovalLevelBand = {
  level: number
  fromCents: number | null
  belowCents: number | null
}

/**
 * The band each level approves, Level 1 first — the one statement of which
 * level approves which order. `amountsCents[0]` is Level 1, and the list must
 * already satisfy `approvalLevelsError`.
 *
 * * Level 1 approves orders equal to or above its amount, with no ceiling.
 * * Level N approves orders equal to or above its amount and below Level N−1's.
 * * The lowest level has no level below it, so its band also reaches down to
 *   zero: it approves every order below the level above it. Its own amount
 *   takes effect only once a lower level is added.
 * * A single level therefore approves every order.
 */
export function approvalLevelBands(amountsCents: readonly number[]): ApprovalLevelBand[] {
  const lowest = amountsCents.length - 1
  return amountsCents.map((cents, index) => ({
    level: index + 1,
    fromCents: index === lowest ? null : cents,
    belowCents: index === 0 ? null : amountsCents[index - 1],
  }))
}

/** "PKR 40,000.00 to under PKR 80,000.00", for labels and hints. */
export function approvalLevelBandText(band: ApprovalLevelBand): string {
  const { fromCents, belowCents } = band
  if (fromCents === null && belowCents === null) return "any amount"
  if (fromCents === null) return `under ${formatApprovalLevelAmount(belowCents as number)}`
  if (belowCents === null) return `${formatApprovalLevelAmount(fromCents)} and above`
  return `${formatApprovalLevelAmount(fromCents)} to under ${formatApprovalLevelAmount(belowCents)}`
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

/* ── Users holding a level ───────────────────────────────────────────────── */
/* plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md                         */

/** `audit_logs.action` when a user's level is set or cleared. */
export const USER_APPROVAL_LEVEL_AUDIT_ACTION = "ASSIGN_ORDER_APPROVAL_LEVEL"

/** What decides whether a user of an organization may hold a level. */
export type ApprovalLevelOrganization = {
  orderApprovalRequired: boolean
  orderApprovalLevelsEnabled: boolean
  /** The organization's configured approver role (`organizations.order_approver_role`). */
  orderApproverRole: string | null
}

/**
 * Whether a user of this role may hold one of this organization's levels: the
 * organization requires approval and has levels on, and the role is one that
 * decides its orders — a Group User always, or the configured approver role.
 */
export function canHoldApprovalLevel(role: string, organization: ApprovalLevelOrganization): boolean {
  if (!organization.orderApprovalRequired || !organization.orderApprovalLevelsEnabled) return false
  return role === "GROUP_USER" || (organization.orderApproverRole !== null && role === organization.orderApproverRole)
}

export const APPROVAL_LEVEL_NOT_APPLICABLE_MESSAGE =
  "Approval levels apply only to order approvers of an organization that requires order approval and has approval levels switched on."

/**
 * Why `level` cannot be given to a user of `role`, or null when it can. Null
 * (no level) is always allowed. `levelCount` is how many levels the
 * organization has now.
 */
export function approvalLevelAssignmentRefusal(input: {
  role: string
  organization: ApprovalLevelOrganization | null
  levelCount: number
  level: number | null
}): string | null {
  if (input.level === null) return null
  if (!Number.isInteger(input.level) || input.level < 1 || input.level > MAX_APPROVAL_LEVELS) {
    return `Choose a level between 1 and ${MAX_APPROVAL_LEVELS}.`
  }
  if (!input.organization || !canHoldApprovalLevel(input.role, input.organization)) {
    return APPROVAL_LEVEL_NOT_APPLICABLE_MESSAGE
  }
  if (input.level > input.levelCount) {
    return `This organization has no Level ${input.level}.`
  }
  return null
}

/** The 409 when removing levels that users still hold. */
export function heldLevelsRemovalMessage(held: readonly { level: number; users: number }[]): string {
  const parts = held.map(({ level, users }) => `Level ${level} (${users} ${users === 1 ? "user" : "users"})`)
  return `These levels are still assigned: ${parts.join(", ")}. Give those users another level, or none, before removing them.`
}

/* ── Routing orders by level ─────────────────────────────────────────────── */
/* plans/OF-APPROVAL-LEVELS-route-orders-by-level.md                          */

/**
 * Whether an organization uses approval levels **now**: approval required,
 * levels switched on, and at least one level saved. Every routing rule below
 * is gated on this, so an organization that never turned levels on is
 * untouched.
 */
export function approvalLevelsActive(organization: {
  orderApprovalRequired: boolean
  orderApprovalLevelsEnabled: boolean
  levelCount: number
}): boolean {
  return organization.orderApprovalRequired
    && organization.orderApprovalLevelsEnabled
    && organization.levelCount > 0
}

/**
 * The level whose band an amount falls in (`approvalLevelBands`): the highest
 * level whose amount it reaches, else the lowest level. Null when there are no
 * levels. `amountsCents[0]` is Level 1.
 */
export function approvalLevelForAmount(amountCents: number, amountsCents: readonly number[]): number | null {
  if (amountsCents.length === 0) return null
  const bands = approvalLevelBands(amountsCents)
  const band = bands.find((candidate) => (candidate.fromCents === null || amountCents >= candidate.fromCents)
    && (candidate.belowCents === null || amountCents < candidate.belowCents))
  return band?.level ?? amountsCents.length
}

/** The person trying to decide a levelled order, as read from the database. */
export type LevelledDecisionActor = {
  userId: string
  role: string
  organizationId: number | null
  /** The single branch of a single-branch role. */
  branchId: number | null
  level: number | null
  /** A Group User's resolved reach; empty for every other role. */
  scopedBranchIds: readonly number[]
}

/**
 * Whether this person may approve, reject or return this levelled order:
 * same organization, holds exactly the order's level in a role that may hold
 * one, reaches the order's branch, and did not raise the order.
 */
export function canDecideLevelledOrder(input: {
  actor: LevelledDecisionActor
  order: { approvalLevel: number; organizationId: number; branchId: number; createdByUserId: string | null }
  organization: ApprovalLevelOrganization
}): boolean {
  const { actor, order } = input
  if (actor.organizationId === null || actor.organizationId !== order.organizationId) return false
  if (actor.level !== order.approvalLevel) return false
  if (!canHoldApprovalLevel(actor.role, input.organization)) return false
  if (order.createdByUserId !== null && actor.userId === order.createdByUserId) return false
  return reachesBranch(actor, order.branchId)
}

/** Whether a level holder's reach covers a branch, by its role. */
export function reachesBranch(
  actor: Pick<LevelledDecisionActor, "role" | "branchId" | "scopedBranchIds">,
  branchId: number,
): boolean {
  if (actor.role === "HEAD_OFFICE") return true
  if (actor.role === "BRANCH_ADMIN") return actor.branchId === branchId
  if (actor.role === "GROUP_USER") return actor.scopedBranchIds.includes(branchId)
  return false
}

/** What an order refused for want of an approver is told. */
export function approvalLevelUnavailableMessage(level: number): string {
  return `No Level ${level} approver covers this branch, so this order cannot be placed yet. Contact your head office.`
}

/** The 409 when removing levels that pending orders are waiting at. */
export function pendingLevelsRemovalMessage(pending: readonly { level: number; orders: number }[]): string {
  const parts = pending.map(({ level, orders }) => `Level ${level} (${orders} ${orders === 1 ? "order" : "orders"})`)
  return `Pending orders are waiting at: ${parts.join(", ")}. Decide them, or keep the level, before removing it.`
}
