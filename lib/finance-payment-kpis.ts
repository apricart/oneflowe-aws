/**
 * The payment KPIs Finance lands on, as pure rules
 * (plans/OF-FINANCE-finance-role.md). The server aggregates rows per
 * organization and per aging bucket; this module names the buckets and turns
 * those rows into the figures the page prints, so the page and the tests
 * agree on what "collection rate" and "overdue" mean.
 *
 * What counts: orders whose payment flag may be set — `APPROVED` or
 * `FULFILLED` (`isPaymentStatusUpdateEligible`) — valued net of refunds,
 * `max(0, total − refunded)`, in integer cents.
 */

export const PAYMENT_AGING_BUCKETS = [
  { key: "0-30", label: "0–30 days", minDays: 0, maxDays: 30 },
  { key: "31-60", label: "31–60 days", minDays: 31, maxDays: 60 },
  { key: "61-90", label: "61–90 days", minDays: 61, maxDays: 90 },
  { key: "90+", label: "Over 90 days", minDays: 91, maxDays: null },
] as const

export type PaymentAgingBucketKey = (typeof PAYMENT_AGING_BUCKETS)[number]["key"]

/** Unpaid orders older than this many days since approval are called overdue. */
export const PAYMENT_OVERDUE_AFTER_DAYS = 30

/** The bucket for an unpaid order this many whole days after approval. */
export function paymentAgingBucketFor(days: number): PaymentAgingBucketKey {
  const whole = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 0
  const bucket = PAYMENT_AGING_BUCKETS.find((candidate) => candidate.maxDays === null || whole <= candidate.maxDays)
  return (bucket ?? PAYMENT_AGING_BUCKETS[PAYMENT_AGING_BUCKETS.length - 1]).key
}

export type PaymentFigure = { count: number; amountCents: number }

export type OrganizationPaymentRow = {
  organizationId: number
  organizationName: string
  paid: PaymentFigure
  unpaid: PaymentFigure
  /** Unpaid and already delivered: goods are with the customer. */
  unpaidDelivered: PaymentFigure
}

export type AgingRow = { bucket: PaymentAgingBucketKey } & PaymentFigure

export type PaymentKpis = {
  paid: PaymentFigure
  unpaid: PaymentFigure
  unpaidDelivered: PaymentFigure
  overdue: PaymentFigure
  /** Paid share of the total amount, 0–100 with one decimal; null when there is nothing to collect. */
  collectionRatePct: number | null
  aging: Array<{ bucket: PaymentAgingBucketKey; label: string } & PaymentFigure>
  organizations: Array<OrganizationPaymentRow & { collectionRatePct: number | null }>
}

const ZERO: PaymentFigure = { count: 0, amountCents: 0 }

function add(a: PaymentFigure, b: PaymentFigure): PaymentFigure {
  return { count: a.count + b.count, amountCents: a.amountCents + b.amountCents }
}

/** Paid share of paid + unpaid amount, rounded to one decimal place. */
export function collectionRatePct(paidCents: number, unpaidCents: number): number | null {
  const total = paidCents + unpaidCents
  if (total <= 0) return null
  return Math.round((paidCents / total) * 1000) / 10
}

/** Whether an aging bucket lies past the overdue threshold. */
export function isOverdueBucket(bucket: PaymentAgingBucketKey): boolean {
  const definition = PAYMENT_AGING_BUCKETS.find((candidate) => candidate.key === bucket)
  return Boolean(definition && definition.minDays > PAYMENT_OVERDUE_AFTER_DAYS)
}

export function summarizePaymentKpis(input: {
  organizations: readonly OrganizationPaymentRow[]
  aging: readonly AgingRow[]
}): PaymentKpis {
  let paid = ZERO
  let unpaid = ZERO
  let unpaidDelivered = ZERO
  for (const row of input.organizations) {
    paid = add(paid, row.paid)
    unpaid = add(unpaid, row.unpaid)
    unpaidDelivered = add(unpaidDelivered, row.unpaidDelivered)
  }

  const aging = PAYMENT_AGING_BUCKETS.map((definition) => {
    const figure = input.aging
      .filter((row) => row.bucket === definition.key)
      .reduce<PaymentFigure>((total, row) => add(total, row), ZERO)
    return { bucket: definition.key, label: definition.label, ...figure }
  })
  const overdue = aging
    .filter((row) => isOverdueBucket(row.bucket))
    .reduce<PaymentFigure>((total, row) => add(total, row), ZERO)

  return {
    paid,
    unpaid,
    unpaidDelivered,
    overdue,
    collectionRatePct: collectionRatePct(paid.amountCents, unpaid.amountCents),
    aging,
    organizations: [...input.organizations]
      .sort((a, b) => b.unpaid.amountCents - a.unpaid.amountCents || a.organizationName.localeCompare(b.organizationName))
      .map((row) => ({ ...row, collectionRatePct: collectionRatePct(row.paid.amountCents, row.unpaid.amountCents) })),
  }
}
