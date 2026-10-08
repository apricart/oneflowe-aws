import { describe, expect, it } from "vitest"

import {
  NOT_CONFIGURED_OVERDUE_SUMMARY,
  PAYMENT_CONTROL_BLOCKED_CODE,
  PAYMENT_CONTROL_POLICY,
  PaymentControlBlockedError,
  addAppCalendarMonths,
  blockedMessageOf,
  exceptionWindowFrom,
  hasExceptionExpired,
  isExceptionActive,
  isPaymentControlBlockedError,
  resolvePaymentControl,
  type OverduePaymentItem,
  type PaymentControlException,
} from "./payment-control-policy"

const NOW = new Date("2026-09-21T09:00:00.000Z")
const THRESHOLD = PAYMENT_CONTROL_POLICY.overdueBlockThreshold

function overdue(items: Array<Partial<OverduePaymentItem> & { reference: string }>) {
  return {
    configured: true,
    overdueCount: items.length,
    items: items.map((item) => ({ reference: item.reference, overdueSince: item.overdueSince ?? null, amountCents: item.amountCents ?? null })),
  }
}

function exception(overrides: Partial<PaymentControlException> = {}): PaymentControlException {
  return {
    id: 7,
    startAt: new Date("2026-09-10T00:00:00.000Z"),
    expiresAt: new Date("2026-10-10T00:00:00.000Z"),
    revokedAt: null,
    grantedByUserId: "ho-user",
    reason: null,
    ...overrides,
  }
}

const twoOverdue = () => overdue([
  { reference: "INV-1", overdueSince: new Date("2026-08-01T00:00:00.000Z") },
  { reference: "INV-2", overdueSince: new Date("2026-08-15T00:00:00.000Z") },
])

describe("the policy constants are the client's stated rule", () => {
  it("blocks at two overdue payments and excepts for one calendar month", () => {
    expect(PAYMENT_CONTROL_POLICY.overdueBlockThreshold).toBe(2)
    expect(PAYMENT_CONTROL_POLICY.exceptionDurationMonths).toBe(1)
  })
})

describe("state without a source", () => {
  it("is NOT_CONFIGURED and never blocks, whatever the count says", () => {
    const status = resolvePaymentControl({
      overdue: { configured: false, overdueCount: 99, items: [] },
      exception: null,
      now: NOW,
    })
    expect(status.state).toBe("NOT_CONFIGURED")
    expect(status.orderingAllowed).toBe(true)
    expect(status.reason).toBe("NOT_CONFIGURED")
    expect(status.overdueCount).toBe(0)
    expect(status.limitReached).toBe(false)
    expect(status.timeline).toEqual([])
  })

  it("the shared constant is that answer", () => {
    const status = resolvePaymentControl({ overdue: NOT_CONFIGURED_OVERDUE_SUMMARY, exception: null, now: NOW })
    expect(status.state).toBe("NOT_CONFIGURED")
    expect(status.orderingAllowed).toBe(true)
  })

  it("an exception on file does not change the answer", () => {
    const status = resolvePaymentControl({ overdue: NOT_CONFIGURED_OVERDUE_SUMMARY, exception: exception(), now: NOW })
    expect(status.state).toBe("NOT_CONFIGURED")
    expect(status.orderingAllowed).toBe(true)
    expect(status.exceptionActive).toBe(true)
  })
})

describe("state with a source", () => {
  it("no overdue payment → CLEAR, ordering allowed", () => {
    const status = resolvePaymentControl({ overdue: overdue([]), exception: null, now: NOW })
    expect(status.state).toBe("CLEAR")
    expect(status.orderingAllowed).toBe(true)
    expect(status.reason).toBe("NO_OVERDUE_PAYMENTS")
    expect(status.timeline.map((step) => [step.key, step.state])).toEqual([["clear", "current"]])
  })

  it("one overdue payment → WARNING, ordering still allowed, limit not reached", () => {
    const status = resolvePaymentControl({
      overdue: overdue([{ reference: "INV-1", overdueSince: new Date("2026-08-01T00:00:00.000Z") }]),
      exception: null,
      now: NOW,
    })
    expect(status.state).toBe("WARNING")
    expect(status.orderingAllowed).toBe(true)
    expect(status.reason).toBe("BELOW_THRESHOLD")
    expect(status.overdueCount).toBe(1)
    expect(status.threshold).toBe(THRESHOLD)
    expect(status.limitReached).toBe(false)
    expect(status.blockedSince).toBeNull()
  })

  it("the threshold reached → BLOCKED, ordering refused", () => {
    const status = resolvePaymentControl({ overdue: twoOverdue(), exception: null, now: NOW })
    expect(status.state).toBe("BLOCKED")
    expect(status.orderingAllowed).toBe(false)
    expect(status.reason).toBe("THRESHOLD_REACHED")
    expect(status.limitReached).toBe(true)
  })

  it("more than the threshold is still BLOCKED", () => {
    const status = resolvePaymentControl({
      overdue: overdue([{ reference: "a" }, { reference: "b" }, { reference: "c" }]),
      exception: null,
      now: NOW,
    })
    expect(status.state).toBe("BLOCKED")
    expect(status.orderingAllowed).toBe(false)
  })

  it("the threshold is injectable so a confirmed figure needs no code change elsewhere", () => {
    const status = resolvePaymentControl({ overdue: twoOverdue(), exception: null, now: NOW, threshold: 3 })
    expect(status.state).toBe("WARNING")
    expect(status.orderingAllowed).toBe(true)
    expect(status.threshold).toBe(3)
  })

  const dated = (count: number) => overdue(Array.from({ length: count }, (_, index) => ({
    reference: `INV-${index + 1}`,
    overdueSince: new Date(Date.UTC(2026, 7, index + 1)),
  })))

  // An organization's own limit (plans/OF-ORDERING-BLOCK-configurable-thresholds.md).
  it.each([
    [1, 0, "CLEAR", true],
    [1, 1, "BLOCKED", false],
    [5, 4, "WARNING", true],
    [5, 5, "BLOCKED", false],
    [5, 6, "BLOCKED", false],
    [100, 99, "WARNING", true],
    [100, 100, "BLOCKED", false],
  ])("with a limit of %i, %i overdue → %s, orderingAllowed %s", (threshold, count, state, allowed) => {
    const status = resolvePaymentControl({ overdue: dated(count), exception: null, now: NOW, threshold })
    expect(status).toMatchObject({ state, orderingAllowed: allowed, threshold, limitReached: !allowed, overdueCount: count })
  })

  it("with a custom limit, the date the limit was reached is the limit-th oldest", () => {
    const status = resolvePaymentControl({ overdue: dated(7), exception: null, now: NOW, threshold: 5 })
    expect(status.blockedSince).toEqual(new Date(Date.UTC(2026, 7, 5)))
  })

  it("with a custom limit, the timeline and the refusal print that limit", () => {
    const warning = resolvePaymentControl({ overdue: dated(3), exception: null, now: NOW, threshold: 5 })
    expect(warning.timeline.find((step) => step.key === "warning")?.description).toBe("3 of 5 overdue payments. Ordering is still available.")
    const blocked = resolvePaymentControl({ overdue: dated(5), exception: null, now: NOW, threshold: 5 })
    expect(new PaymentControlBlockedError(blocked).details).toMatchObject({ overdueCount: 5, threshold: 5 })
    expect(new PaymentControlBlockedError(blocked).message).toBe("You have 5 unpaid invoices. Please pay your dues before placing a new order.")
  })

  it("a Head Office exception still lets a branch past a custom limit", () => {
    const status = resolvePaymentControl({ overdue: dated(1), exception: exception(), now: NOW, threshold: 1 })
    expect(status).toMatchObject({ state: "BLOCKED", exceptionActive: true, orderingAllowed: true })
  })

  it.each([0, -1, 101, 1.5, Number.NaN])(
    "an out-of-bounds limit (%s) falls back to the default, never to 'never block' or 'always block'",
    (threshold) => {
      const clear = resolvePaymentControl({ overdue: overdue([]), exception: null, now: NOW, threshold })
      expect(clear).toMatchObject({ state: "CLEAR", orderingAllowed: true, threshold: THRESHOLD })
      const blocked = resolvePaymentControl({ overdue: twoOverdue(), exception: null, now: NOW, threshold })
      expect(blocked).toMatchObject({ state: "BLOCKED", orderingAllowed: false, threshold: THRESHOLD })
    },
  )

  it("not configured ignores any limit", () => {
    const status = resolvePaymentControl({
      overdue: { configured: false, overdueCount: 5, items: [] },
      exception: null,
      now: NOW,
      threshold: 1,
    })
    expect(status).toMatchObject({ state: "NOT_CONFIGURED", orderingAllowed: true })
  })

  it("a negative or fractional count from a faulty source is clamped, never trusted", () => {
    const status = resolvePaymentControl({
      overdue: { configured: true, overdueCount: -3, items: [] },
      exception: null,
      now: NOW,
    })
    expect(status.overdueCount).toBe(0)
    expect(status.state).toBe("CLEAR")
  })

  it("blockedSince is the instant the threshold-th payment became overdue, when every item is dated", () => {
    const status = resolvePaymentControl({ overdue: twoOverdue(), exception: null, now: NOW })
    expect(status.blockedSince).toEqual(new Date("2026-08-15T00:00:00.000Z"))
  })

  it("blockedSince is null when any counted item has no date — no date is invented", () => {
    const status = resolvePaymentControl({
      overdue: overdue([{ reference: "INV-1", overdueSince: new Date("2026-08-01T00:00:00.000Z") }, { reference: "INV-2" }]),
      exception: null,
      now: NOW,
    })
    expect(status.state).toBe("BLOCKED")
    expect(status.blockedSince).toBeNull()
  })
})

describe("the Head Office exception", () => {
  it("in force → BLOCKED state but ordering allowed, flagged as an exception", () => {
    const status = resolvePaymentControl({ overdue: twoOverdue(), exception: exception(), now: NOW })
    expect(status.state).toBe("BLOCKED")
    expect(status.orderingAllowed).toBe(true)
    expect(status.exceptionActive).toBe(true)
    expect(status.reason).toBe("EXCEPTION_ACTIVE")
  })

  it("is in force up to but not including its expiry instant", () => {
    const expiresAt = new Date("2026-10-10T00:00:00.000Z")
    const grant = exception({ expiresAt })
    expect(isExceptionActive(grant, new Date(expiresAt.getTime() - 1))).toBe(true)
    expect(isExceptionActive(grant, expiresAt)).toBe(false)
    expect(hasExceptionExpired(grant, expiresAt)).toBe(true)
    expect(hasExceptionExpired(grant, new Date(expiresAt.getTime() - 1))).toBe(false)
  })

  it("expired → ordering refused again while the condition persists", () => {
    const status = resolvePaymentControl({
      overdue: twoOverdue(),
      exception: exception({ expiresAt: new Date("2026-09-21T09:00:00.000Z") }),
      now: NOW,
    })
    expect(status.orderingAllowed).toBe(false)
    expect(status.exceptionActive).toBe(false)
    expect(status.reason).toBe("EXCEPTION_EXPIRED")
    expect(status.timeline.map((step) => step.key)).toContain("exception-expired")
  })

  it("revoked → ordering refused, whatever the expiry says", () => {
    const status = resolvePaymentControl({
      overdue: twoOverdue(),
      exception: exception({ revokedAt: new Date("2026-09-15T00:00:00.000Z") }),
      now: NOW,
    })
    expect(status.orderingAllowed).toBe(false)
    expect(status.reason).toBe("EXCEPTION_REVOKED")
    expect(isExceptionActive(status.exception, NOW)).toBe(false)
  })

  it("not yet started → not in force", () => {
    const status = resolvePaymentControl({
      overdue: twoOverdue(),
      exception: exception({ startAt: new Date("2026-09-22T00:00:00.000Z"), expiresAt: new Date("2026-10-22T00:00:00.000Z") }),
      now: NOW,
    })
    expect(status.orderingAllowed).toBe(false)
    expect(status.exceptionActive).toBe(false)
    expect(status.reason).toBe("THRESHOLD_REACHED")
    expect(status.timeline.map((step) => step.key)).toContain("exception-pending")
  })

  it("payments cleared while the exception is live → CLEAR; the exception is history", () => {
    const status = resolvePaymentControl({ overdue: overdue([]), exception: exception(), now: NOW })
    expect(status.state).toBe("CLEAR")
    expect(status.orderingAllowed).toBe(true)
    expect(status.reason).toBe("NO_OVERDUE_PAYMENTS")
    expect(status.timeline.map((step) => step.key)).toEqual(["exception-granted:7", "clear"])
  })

  it("is one calendar month long in Asia/Karachi", () => {
    const window = exceptionWindowFrom(new Date("2026-09-21T09:00:00.000Z"))
    expect(window.startAt).toEqual(new Date("2026-09-21T09:00:00.000Z"))
    expect(window.expiresAt).toEqual(new Date("2026-10-21T09:00:00.000Z"))
  })
})

describe("addAppCalendarMonths", () => {
  it("keeps the Karachi wall-clock time", () => {
    // 2026-01-31 23:30 Karachi is 18:30Z; one month on clamps to 28 Feb.
    expect(addAppCalendarMonths(new Date("2026-01-31T18:30:00.000Z"), 1)).toEqual(new Date("2026-02-28T18:30:00.000Z"))
  })

  it("crosses a year", () => {
    expect(addAppCalendarMonths(new Date("2026-12-15T05:00:00.000Z"), 1)).toEqual(new Date("2027-01-15T05:00:00.000Z"))
  })

  it("respects a Karachi date that is still the previous UTC day", () => {
    // 2026-03-31 02:00 Karachi is 2026-03-30 21:00Z. One month → 30 Apr 02:00 Karachi = 29 Apr 21:00Z.
    expect(addAppCalendarMonths(new Date("2026-03-30T21:00:00.000Z"), 1)).toEqual(new Date("2026-04-29T21:00:00.000Z"))
  })
})

describe("the timeline", () => {
  it("below the threshold: overdue → warning → stops if limit reached → cleared, with no invented stop date", () => {
    const status = resolvePaymentControl({
      overdue: overdue([{ reference: "INV-1", overdueSince: new Date("2026-08-01T00:00:00.000Z") }]),
      exception: null,
      now: NOW,
    })
    expect(status.timeline.map((step) => [step.key, step.state, step.at?.toISOString() ?? null])).toEqual([
      ["overdue:INV-1", "complete", "2026-08-01T00:00:00.000Z"],
      ["warning", "current", null],
      ["will-block", "upcoming", null],
      ["cleared", "upcoming", null],
    ])
  })

  it("blocked with no exception: limit reached and ordering stopped share the instant", () => {
    const status = resolvePaymentControl({ overdue: twoOverdue(), exception: null, now: NOW })
    expect(status.timeline.map((step) => [step.key, step.state, step.at?.toISOString() ?? null])).toEqual([
      ["overdue:INV-1", "complete", "2026-08-01T00:00:00.000Z"],
      ["overdue:INV-2", "complete", "2026-08-15T00:00:00.000Z"],
      ["limit-reached", "complete", "2026-08-15T00:00:00.000Z"],
      ["blocked", "current", "2026-08-15T00:00:00.000Z"],
      ["cleared", "upcoming", null],
    ])
  })

  it("blocked with a live exception: granted → allowed now → expires → stopped again → cleared", () => {
    const status = resolvePaymentControl({ overdue: twoOverdue(), exception: exception({ reason: "Cheque in transit" }), now: NOW })
    expect(status.timeline.map((step) => [step.key, step.state])).toEqual([
      ["overdue:INV-1", "complete"],
      ["overdue:INV-2", "complete"],
      ["limit-reached", "complete"],
      ["blocked", "complete"],
      ["exception-granted:7", "complete"],
      ["exception-active", "current"],
      ["exception-expires", "upcoming"],
      ["blocked-again", "upcoming"],
      ["cleared", "upcoming"],
    ])
    expect(status.timeline.find((step) => step.key === "exception-granted:7")?.description).toBe("Cheque in transit")
    expect(status.timeline.find((step) => step.key === "exception-expires")?.at).toEqual(new Date("2026-10-10T00:00:00.000Z"))
  })

  it("blocked after a revoke: granted → revoked → stopped again (current)", () => {
    const revokedAt = new Date("2026-09-15T00:00:00.000Z")
    const status = resolvePaymentControl({ overdue: twoOverdue(), exception: exception({ revokedAt }), now: NOW })
    expect(status.timeline.map((step) => [step.key, step.state])).toEqual([
      ["overdue:INV-1", "complete"],
      ["overdue:INV-2", "complete"],
      ["limit-reached", "complete"],
      ["blocked", "complete"],
      ["exception-granted:7", "complete"],
      ["exception-revoked:7", "complete"],
      ["blocked-again", "current"],
      ["cleared", "upcoming"],
    ])
    expect(status.timeline.find((step) => step.key === "blocked-again")?.at).toEqual(revokedAt)
  })

  it("undated overdue payments are shown undated rather than dropped", () => {
    const status = resolvePaymentControl({
      overdue: overdue([{ reference: "a" }, { reference: "b" }]),
      exception: null,
      now: NOW,
    })
    const undated = status.timeline.find((step) => step.key === "overdue:undated")
    expect(undated).toMatchObject({ label: "2 payments overdue", at: null, state: "complete" })
    expect(status.timeline.find((step) => step.key === "blocked")?.at).toBeNull()
  })
})

describe("the refusal", () => {
  it("carries a stable code and only what the UI needs", () => {
    const status = resolvePaymentControl({ overdue: twoOverdue(), exception: null, now: NOW })
    const error = new PaymentControlBlockedError(status)
    expect(error.code).toBe(PAYMENT_CONTROL_BLOCKED_CODE)
    expect(error.details).toEqual({
      code: "PAYMENT_CONTROL_BLOCKED",
      state: "BLOCKED",
      reason: "THRESHOLD_REACHED",
      overdueCount: 2,
      threshold: THRESHOLD,
      exceptionExpiredAt: null,
    })
    expect(Object.keys(error.details)).not.toContain("overdueItems")
    expect(isPaymentControlBlockedError(error)).toBe(true)
    expect(isPaymentControlBlockedError(new Error("Insufficient budget"))).toBe(false)
  })

  it("names the expired exception when that is why", () => {
    const expiresAt = new Date("2026-09-20T00:00:00.000Z")
    const status = resolvePaymentControl({ overdue: twoOverdue(), exception: exception({ expiresAt }), now: NOW })
    const error = new PaymentControlBlockedError(status)
    expect(error.details.exceptionExpiredAt).toEqual(expiresAt)
    expect(error.message).toContain("exception has expired")
  })

  // The only connected source counts unpaid invoices
  // (plans/OF-PAYMENT-CONTROL-unpaid-invoice-ordering-block.md), so the refusal
  // names them and asks for payment, as the requirement words it.
  it("the message names the unpaid invoices and asks for the dues", () => {
    expect(blockedMessageOf({ reason: "THRESHOLD_REACHED", overdueCount: 2, threshold: 2 }))
      .toBe("You have 2 unpaid invoices. Please pay your dues before placing a new order.")
  })

  it("the message prints the real count, singular or plural", () => {
    expect(blockedMessageOf({ reason: "THRESHOLD_REACHED", overdueCount: 5, threshold: 2 }))
      .toBe("You have 5 unpaid invoices. Please pay your dues before placing a new order.")
    expect(blockedMessageOf({ reason: "THRESHOLD_REACHED", overdueCount: 1, threshold: 1 }))
      .toBe("You have 1 unpaid invoice. Please pay your dues before placing a new order.")
  })

  it("the message says when a Head Office exception was revoked", () => {
    expect(blockedMessageOf({ reason: "EXCEPTION_REVOKED", overdueCount: 2, threshold: 2 }))
      .toBe("You have 2 unpaid invoices. Please pay your dues before placing a new order. The Head Office exception was revoked.")
  })
})
