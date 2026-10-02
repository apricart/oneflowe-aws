/**
 * Branch payment control: the rule that decides whether a branch may place a
 * new order given its overdue payments and any Head Office exception
 * (plans/OF-PAYMENT-CONTROL-overdue-ordering-block.md).
 *
 * Pure. No database, no session, no clock of its own: every function takes
 * the facts and `now` and returns a decision. The server module
 * (lib/server/payment-control.ts) gathers the facts; the two order-creation
 * paths and the UI depend only on the shapes here.
 *
 * Nothing about the state is persisted. The only stored fact is the
 * exception grant; CLEAR / WARNING / BLOCKED are recomputed on every read,
 * and an exception is in force exactly while `now < expiresAt`, so an expiry
 * takes effect at the instant without a job.
 */

/**
 * The policy numbers, in one place. Both are the client's words as of
 * 2026-09-21 and both are unconfirmed (plan, open questions 3 and 6). Change
 * them here and nowhere else; the routes, the gate and the UI read them from
 * here and print them rather than repeating them.
 */
export const PAYMENT_CONTROL_POLICY = {
  /** Overdue payments at which new ordering stops. */
  overdueBlockThreshold: 2,
  /** How long a Head Office exception lasts: calendar months, Asia/Karachi. */
  exceptionDurationMonths: 1,
} as const

const APP_TIME_ZONE_OFFSET_MS = 5 * 60 * 60 * 1000

export const PAYMENT_CONTROL_BLOCKED_CODE = "PAYMENT_CONTROL_BLOCKED" as const

/**
 * NOT_CONFIGURED — no overdue-payment source is connected; nothing can be
 *                  said about the branch and nothing is blocked.
 * CLEAR          — the source knows the branch and reports no overdue payment.
 * WARNING        — overdue payments exist but the limit is not reached.
 * BLOCKED        — the limit is reached. Ordering is refused unless an
 *                  exception is in force; the condition is still unresolved
 *                  either way, which is why an active exception is a flag
 *                  beside BLOCKED and not a state of its own.
 */
export type PaymentControlState = "NOT_CONFIGURED" | "CLEAR" | "WARNING" | "BLOCKED"

export type PaymentControlReason =
  | "NOT_CONFIGURED"
  | "NO_OVERDUE_PAYMENTS"
  | "BELOW_THRESHOLD"
  | "THRESHOLD_REACHED"
  | "EXCEPTION_ACTIVE"
  | "EXCEPTION_EXPIRED"
  | "EXCEPTION_REVOKED"

/** One overdue payment as the source reports it. Dates may be unknown. */
export type OverduePaymentItem = {
  reference: string
  overdueSince: Date | null
  amountCents: number | null
}

/**
 * What the overdue-payment source says about one branch. `configured: false`
 * is the honest answer while no source exists; the count and items are then
 * meaningless and must be ignored.
 */
export type OverduePaymentSummary = {
  configured: boolean
  overdueCount: number
  items: OverduePaymentItem[]
}

export const NOT_CONFIGURED_OVERDUE_SUMMARY: OverduePaymentSummary = Object.freeze({
  configured: false,
  overdueCount: 0,
  items: [],
})

export type PaymentControlException = {
  id: number
  startAt: Date
  expiresAt: Date
  revokedAt: Date | null
  grantedByUserId: string
  reason: string | null
}

export type PaymentControlTimelineStep = {
  key: string
  label: string
  description: string
  at: Date | null
  state: "complete" | "current" | "upcoming"
}

export type PaymentControlStatus = {
  state: PaymentControlState
  orderingAllowed: boolean
  reason: PaymentControlReason
  configured: boolean
  overdueCount: number
  threshold: number
  limitReached: boolean
  overdueItems: OverduePaymentItem[]
  /** When the limit was reached, if every counted item carries a date. */
  blockedSince: Date | null
  exception: PaymentControlException | null
  exceptionActive: boolean
  timeline: PaymentControlTimelineStep[]
  evaluatedAt: Date
}

/** The part of a status that is safe to hand back with a refused order. */
export type PaymentControlBlockedDetails = {
  code: typeof PAYMENT_CONTROL_BLOCKED_CODE
  state: PaymentControlState
  reason: PaymentControlReason
  overdueCount: number
  threshold: number
  exceptionExpiredAt: Date | null
}

export function isExceptionActive(
  exception: Pick<PaymentControlException, "startAt" | "expiresAt" | "revokedAt"> | null | undefined,
  now: Date,
): boolean {
  if (!exception) return false
  if (exception.revokedAt) return false
  const at = now.getTime()
  return exception.startAt.getTime() <= at && at < exception.expiresAt.getTime()
}

export function hasExceptionExpired(
  exception: Pick<PaymentControlException, "expiresAt" | "revokedAt"> | null | undefined,
  now: Date,
): boolean {
  if (!exception || exception.revokedAt) return false
  return exception.expiresAt.getTime() <= now.getTime()
}

/**
 * The same wall-clock instant `months` calendar months later in Asia/Karachi
 * (a fixed +05:00 zone, as lib/date-range-params.ts also assumes). A day the
 * target month does not have clamps to its last day: 31 Jan → 28/29 Feb.
 */
export function addAppCalendarMonths(instant: Date, months: number): Date {
  const local = new Date(instant.getTime() + APP_TIME_ZONE_OFFSET_MS)
  const target = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + months, 1))
  const lastDayOfTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(local.getUTCDate(), lastDayOfTarget))
  target.setUTCHours(local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds())
  return new Date(target.getTime() - APP_TIME_ZONE_OFFSET_MS)
}

/** The window a new exception granted at `now` would cover under the policy. */
export function exceptionWindowFrom(now: Date): { startAt: Date; expiresAt: Date } {
  return {
    startAt: now,
    expiresAt: addAppCalendarMonths(now, PAYMENT_CONTROL_POLICY.exceptionDurationMonths),
  }
}

function blockedSinceOf(items: OverduePaymentItem[], threshold: number): Date | null {
  if (items.length < threshold) return null
  const dated = items.map((item) => item.overdueSince).filter((date): date is Date => date instanceof Date)
  if (dated.length < items.length) return null
  const sorted = [...dated].sort((left, right) => left.getTime() - right.getTime())
  return sorted[threshold - 1] ?? null
}

function reasonOf(input: {
  configured: boolean
  overdueCount: number
  limitReached: boolean
  exception: PaymentControlException | null
  exceptionActive: boolean
  now: Date
}): PaymentControlReason {
  if (!input.configured) return "NOT_CONFIGURED"
  if (input.overdueCount === 0) return "NO_OVERDUE_PAYMENTS"
  if (!input.limitReached) return "BELOW_THRESHOLD"
  if (input.exceptionActive) return "EXCEPTION_ACTIVE"
  if (input.exception?.revokedAt) return "EXCEPTION_REVOKED"
  if (hasExceptionExpired(input.exception, input.now)) return "EXCEPTION_EXPIRED"
  return "THRESHOLD_REACHED"
}

/**
 * Decide for one branch. `exception` is the branch's most recent grant,
 * whatever its liveness — the decision needs to know that one expired or was
 * revoked, not only that none is in force.
 */
export function resolvePaymentControl(input: {
  overdue: OverduePaymentSummary
  exception: PaymentControlException | null
  now: Date
  threshold?: number
}): PaymentControlStatus {
  const threshold = input.threshold ?? PAYMENT_CONTROL_POLICY.overdueBlockThreshold
  const configured = input.overdue.configured === true
  const overdueCount = configured ? Math.max(0, Math.trunc(input.overdue.overdueCount)) : 0
  const overdueItems = configured ? input.overdue.items : []
  const limitReached = configured && overdueCount >= threshold
  const exceptionActive = isExceptionActive(input.exception, input.now)

  let state: PaymentControlState = "NOT_CONFIGURED"
  if (configured) {
    if (overdueCount === 0) state = "CLEAR"
    else if (limitReached) state = "BLOCKED"
    else state = "WARNING"
  }

  const status: PaymentControlStatus = {
    state,
    orderingAllowed: !limitReached || exceptionActive,
    reason: reasonOf({ configured, overdueCount, limitReached, exception: input.exception, exceptionActive, now: input.now }),
    configured,
    overdueCount,
    threshold,
    limitReached,
    overdueItems,
    blockedSince: limitReached ? blockedSinceOf(overdueItems, threshold) : null,
    exception: input.exception,
    exceptionActive,
    timeline: [],
    evaluatedAt: input.now,
  }
  status.timeline = buildPaymentControlTimeline(status)
  return status
}

/**
 * The consequence timeline, from facts only. No grace period is modelled, so
 * "limit reached" and "ordering stopped" share an instant and no future stop
 * date is ever printed; a step whose date the data does not carry has
 * `at: null` and is still shown, undated.
 */
type TimelineStatus = Omit<PaymentControlStatus, "timeline">

function clearTimeline(exception: PaymentControlException | null): PaymentControlTimelineStep[] {
  const steps: PaymentControlTimelineStep[] = []
  if (exception) {
    steps.push(grantedStep(exception, "complete"))
    if (exception.revokedAt) steps.push(revokedStep(exception, "complete"))
  }
  steps.push({ key: "clear", label: "No overdue payments", description: "Ordering is available.", at: null, state: "current" })
  return steps
}

function overdueTimeline(status: TimelineStatus): PaymentControlTimelineStep[] {
  const dated = status.overdueItems
    .filter((item) => item.overdueSince instanceof Date)
    .sort((left, right) => (left.overdueSince as Date).getTime() - (right.overdueSince as Date).getTime())
  const steps = dated.map((item): PaymentControlTimelineStep => ({
    key: `overdue:${item.reference}`,
    label: "Payment overdue",
    description: item.reference,
    at: item.overdueSince,
    state: "complete",
  }))
  const undated = status.overdueCount - dated.length
  if (undated > 0) {
    steps.push({
      key: "overdue:undated",
      label: undated === 1 ? "Payment overdue" : `${undated} payments overdue`,
      description: "Date not recorded.",
      at: null,
      state: "complete",
    })
  }
  return steps
}

function warningTimeline(status: TimelineStatus): PaymentControlTimelineStep[] {
  return [
    {
      key: "warning",
      label: "Warning",
      description: `${status.overdueCount} of ${status.threshold} overdue payments. Ordering is still available.`,
      at: null,
      state: "current",
    },
    {
      key: "will-block",
      label: "Ordering stops if the limit is reached",
      description: `New orders are refused once ${status.threshold} payments are overdue.`,
      at: null,
      state: "upcoming",
    },
    clearedStep(),
  ]
}

function appendExceptionTimeline(steps: PaymentControlTimelineStep[], status: TimelineStatus): void {
  const exception = status.exception
  if (!exception) return
  steps.push(grantedStep(exception, "complete"))
  if (exception.revokedAt) {
    steps.push(revokedStep(exception, "complete"), blockedAgainStep("current", exception.revokedAt))
    return
  }
  if (status.exceptionActive) {
    steps.push(
      { key: "exception-active", label: "Ordering allowed by exception", description: "The overdue payments are still unresolved. Ordering is allowed only while the exception lasts.", at: null, state: "current" },
      { key: "exception-expires", label: "Exception expires", description: "After this, ordering stops again unless the payments have been cleared.", at: exception.expiresAt, state: "upcoming" },
      blockedAgainStep("upcoming", exception.expiresAt),
    )
    return
  }
  if (exception.expiresAt.getTime() <= status.evaluatedAt.getTime()) {
    steps.push(
      { key: "exception-expired", label: "Exception expired", description: "The Head Office exception has ended.", at: exception.expiresAt, state: "complete" },
      blockedAgainStep("current", exception.expiresAt),
    )
    return
  }
  steps.push({ key: "exception-pending", label: "Exception starts", description: "Ordering will be allowed from this time.", at: exception.startAt, state: "upcoming" })
}

export function buildPaymentControlTimeline(status: TimelineStatus): PaymentControlTimelineStep[] {
  if (!status.configured) return []
  if (status.state === "CLEAR") return clearTimeline(status.exception)

  const steps = overdueTimeline(status)
  if (status.state === "WARNING") return [...steps, ...warningTimeline(status)]

  steps.push(
    { key: "limit-reached", label: "Overdue limit reached", description: `${status.overdueCount} overdue payments; the limit is ${status.threshold}.`, at: status.blockedSince, state: "complete" },
    { key: "blocked", label: "Ordering stopped", description: "New orders for this branch are refused until the overdue payments are cleared.", at: status.blockedSince, state: status.exception ? "complete" : "current" },
  )
  appendExceptionTimeline(steps, status)
  steps.push(clearedStep())
  return steps
}

function grantedStep(exception: PaymentControlException, state: PaymentControlTimelineStep["state"]): PaymentControlTimelineStep {
  return {
    key: `exception-granted:${exception.id}`,
    label: "Head Office exception granted",
    description: exception.reason ? exception.reason : "Ordering allowed temporarily despite overdue payments.",
    at: exception.startAt,
    state,
  }
}

function revokedStep(exception: PaymentControlException, state: PaymentControlTimelineStep["state"]): PaymentControlTimelineStep {
  return {
    key: `exception-revoked:${exception.id}`,
    label: "Exception revoked",
    description: "Head Office ended the exception early.",
    at: exception.revokedAt,
    state,
  }
}

function blockedAgainStep(state: PaymentControlTimelineStep["state"], at: Date | null): PaymentControlTimelineStep {
  return {
    key: "blocked-again",
    label: "Ordering stopped again",
    description: "The overdue payments were not cleared.",
    at,
    state,
  }
}

function clearedStep(): PaymentControlTimelineStep {
  return {
    key: "cleared",
    label: "Payments cleared — ordering restored",
    description: "Once the overdue payments are cleared, ordering resumes automatically.",
    at: null,
    state: "upcoming",
  }
}

export function blockedDetailsOf(status: PaymentControlStatus): PaymentControlBlockedDetails {
  return {
    code: PAYMENT_CONTROL_BLOCKED_CODE,
    state: status.state,
    reason: status.reason,
    overdueCount: status.overdueCount,
    threshold: status.threshold,
    exceptionExpiredAt: status.reason === "EXCEPTION_EXPIRED" && status.exception ? status.exception.expiresAt : null,
  }
}

/**
 * The sentence an ordering user is shown when an order is refused. The only
 * connected source counts unpaid invoices
 * (plans/OF-PAYMENT-CONTROL-unpaid-invoice-ordering-block.md), so it says so.
 */
export function blockedMessageOf(status: Pick<PaymentControlStatus, "reason" | "overdueCount" | "threshold">): string {
  const invoices = `${status.overdueCount} unpaid invoice${status.overdueCount === 1 ? "" : "s"}`
  const base = `You have ${invoices}. Please pay your dues before placing a new order.`
  if (status.reason === "EXCEPTION_EXPIRED") return `${base} The Head Office exception has expired.`
  if (status.reason === "EXCEPTION_REVOKED") return `${base} The Head Office exception was revoked.`
  return base
}

/**
 * Thrown by the order gate. The routes map it to a stable response — never to
 * a 500 — and the payload carries only what the UI needs to explain itself.
 */
export class PaymentControlBlockedError extends Error {
  readonly code = PAYMENT_CONTROL_BLOCKED_CODE
  readonly details: PaymentControlBlockedDetails

  constructor(status: PaymentControlStatus) {
    super(blockedMessageOf(status))
    this.name = "PaymentControlBlockedError"
    this.details = blockedDetailsOf(status)
  }
}

export function isPaymentControlBlockedError(error: unknown): error is PaymentControlBlockedError {
  return error instanceof PaymentControlBlockedError
    || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === PAYMENT_CONTROL_BLOCKED_CODE)
}
