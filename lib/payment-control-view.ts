import type {
  PaymentControlException,
  PaymentControlReason,
  PaymentControlState,
  PaymentControlStatus,
  PaymentControlTimelineStep,
} from "@/lib/payment-control-policy"
import { isExceptionActive } from "@/lib/payment-control-policy"

/**
 * The wire shape of a branch's payment-control state — what
 * GET /api/v1/payment-control returns and what the banner, the timeline and
 * the Head Office panel render. Dates are ISO strings.
 *
 * The granter's identity and both reasons are administrative detail: they
 * are returned only to a caller who may manage exceptions, and are `null`
 * for an ordering user, who is told that Head Office allowed ordering and
 * until when, and nothing more.
 */
export type PaymentControlExceptionView = {
  id: number
  startAt: string
  expiresAt: string
  revokedAt: string | null
  active: boolean
  grantedBy: { userId: string; name: string | null } | null
  reason: string | null
  revokeReason: string | null
}

export type PaymentControlTimelineStepView = Omit<PaymentControlTimelineStep, "at"> & { at: string | null }

export type PaymentControlView = {
  branch: { id: number; name: string }
  state: PaymentControlState
  orderingAllowed: boolean
  reason: PaymentControlReason
  configured: boolean
  overdueCount: number
  threshold: number
  limitReached: boolean
  overdueItems: Array<{ reference: string; overdueSince: string | null; amountCents: number | null }>
  blockedSince: string | null
  exception: PaymentControlExceptionView | null
  exceptionActive: boolean
  timeline: PaymentControlTimelineStepView[]
  evaluatedAt: string
  canManageExceptions: boolean
}

type ExceptionRecordLike = PaymentControlException & {
  grantedByName?: string | null
  revokeReason?: string | null
}

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)

export function presentPaymentControlException(
  exception: ExceptionRecordLike,
  options: { canManage: boolean; now: Date },
): PaymentControlExceptionView {
  return {
    id: exception.id,
    startAt: exception.startAt.toISOString(),
    expiresAt: exception.expiresAt.toISOString(),
    revokedAt: iso(exception.revokedAt),
    active: isExceptionActive(exception, options.now),
    grantedBy: options.canManage ? { userId: exception.grantedByUserId, name: exception.grantedByName ?? null } : null,
    reason: options.canManage ? exception.reason : null,
    revokeReason: options.canManage ? exception.revokeReason ?? null : null,
  }
}

export function presentPaymentControl(
  status: Omit<PaymentControlStatus, "exception"> & { exception: ExceptionRecordLike | null },
  options: { branch: { id: number; name: string }; canManage: boolean },
): PaymentControlView {
  const now = status.evaluatedAt
  return {
    branch: { id: options.branch.id, name: options.branch.name },
    state: status.state,
    orderingAllowed: status.orderingAllowed,
    reason: status.reason,
    configured: status.configured,
    overdueCount: status.overdueCount,
    threshold: status.threshold,
    limitReached: status.limitReached,
    overdueItems: status.overdueItems.map((item) => ({
      reference: item.reference,
      overdueSince: iso(item.overdueSince),
      amountCents: item.amountCents,
    })),
    blockedSince: iso(status.blockedSince),
    exception: status.exception ? presentPaymentControlException(status.exception, { canManage: options.canManage, now }) : null,
    exceptionActive: status.exceptionActive,
    timeline: status.timeline.map((step) => ({
      ...step,
      // A timeline step's reason text is the exception's reason; an ordering
      // user gets the neutral wording instead.
      description: !options.canManage && step.key.startsWith("exception-granted:")
        ? "Ordering allowed temporarily despite overdue payments."
        : step.description,
      at: iso(step.at),
    })),
    evaluatedAt: now.toISOString(),
    canManageExceptions: options.canManage,
  }
}
