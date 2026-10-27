/**
 * An organization's price contract validity, in one place
 * (plans/OF-PRICE-CONTRACT-organization-price-contract-validity.md).
 *
 * Super Admin records the last day an organization's agreed prices are valid
 * for (`organizations.price_contract_valid_until`, a Karachi calendar day). As
 * that day approaches, Super Admin and the organization's assigned Apricart
 * Executives are reminded to review the prices. It is a reminder only: no
 * order, price, catalogue or budget rule reads it, and no customer is told.
 *
 * Pure: no database, no clock. Callers pass "today" as a Karachi `YYYY-MM-DD`.
 */

/** How many days before the contract's last day the reminder starts. */
export const PRICE_CONTRACT_REMINDER_DAYS = 7

/** Who is reminded and sees the dashboard alert. */
export const PRICE_CONTRACT_ALERT_ROLES: readonly string[] = ["SUPER_ADMIN", "APRICART_EXECUTIVE"]

/** `notifications.type` and `email_outbox.template` of the reminder. */
export const PRICE_CONTRACT_EXPIRING_TEMPLATE = "PRICE_CONTRACT_EXPIRING"

/** `audit_logs.action` for a change to an organization's contract date. */
export const PRICE_CONTRACT_VALIDITY_AUDIT_ACTION = "UPDATE_ORGANIZATION_PRICE_CONTRACT_VALIDITY"

/** The range of days the field accepts. A past day is allowed: a lapsed contract can be recorded. */
export const PRICE_CONTRACT_DATE_MIN = "2000-01-01"
export const PRICE_CONTRACT_DATE_MAX = "2100-12-31"

export type PriceContractStatus = "none" | "active" | "expiring" | "expired"

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

/** Whether `YYYY-MM-DD` names a day the calendar has — the Date parser would roll "2026-02-31" into March. */
export function isPriceContractCalendarDay(value: string): boolean {
  if (!DAY_PATTERN.test(value)) return false
  const [year, month, day] = value.split("-").map(Number)
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

/** Why a typed contract date is refused, or null when it is acceptable. */
export function priceContractDateRefusal(value: string): string | null {
  if (!isPriceContractCalendarDay(value)) return "Price contract date must be a real date in YYYY-MM-DD format"
  // `YYYY-MM-DD` strings order the same way as the days they name.
  if (value < PRICE_CONTRACT_DATE_MIN || value > PRICE_CONTRACT_DATE_MAX) {
    return `Price contract date must be between ${PRICE_CONTRACT_DATE_MIN} and ${PRICE_CONTRACT_DATE_MAX}`
  }
  return null
}

function dayNumber(day: string): number {
  const [year, month, date] = day.split("-").map(Number)
  return Date.UTC(year, month - 1, date) / DAY_MS
}

/** Whole days from `today` to the contract's last day: 0 on the day itself, negative once it has passed. */
export function priceContractDaysLeft(validUntil: string, today: string): number {
  return dayNumber(validUntil) - dayNumber(today)
}

/** The contract is valid through its last day; it is expiring in the last `PRICE_CONTRACT_REMINDER_DAYS` of it. */
export function priceContractStatus(validUntil: string | null | undefined, today: string): PriceContractStatus {
  if (!validUntil || !isPriceContractCalendarDay(validUntil)) return "none"
  const daysLeft = priceContractDaysLeft(validUntil, today)
  if (daysLeft < 0) return "expired"
  if (daysLeft <= PRICE_CONTRACT_REMINDER_DAYS) return "expiring"
  return "active"
}

/** The last day of the reminder window that starts today: contracts ending on or before it are due. */
export function priceContractReminderHorizon(today: string): string {
  const horizon = new Date((dayNumber(today) + PRICE_CONTRACT_REMINDER_DAYS) * DAY_MS)
  return horizon.toISOString().slice(0, 10)
}

/**
 * One reminder per organization, contract date and recipient. The date is in
 * the key, so changing it re-arms the reminder and re-saving it does not.
 */
export function priceContractReminderEventKey(input: {
  organizationId: number
  validUntil: string
  recipientUserId: string
}): string {
  return `${PRICE_CONTRACT_EXPIRING_TEMPLATE}:${input.organizationId}:${input.validUntil}:${input.recipientUserId}`
}

const DAY_LABEL = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" })

/** "31 Dec 2026", for a `YYYY-MM-DD` day. */
export function formatPriceContractDay(day: string): string {
  if (!isPriceContractCalendarDay(day)) return day
  const [year, month, date] = day.split("-").map(Number)
  return DAY_LABEL.format(new Date(Date.UTC(year, month - 1, date)))
}

/** "expires today", "expires in 1 day", "expires in 5 days", "expired 3 days ago". */
export function priceContractDaysLabel(daysLeft: number): string {
  if (daysLeft === 0) return "expires today"
  if (daysLeft > 0) return `expires in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}`
  const ago = -daysLeft
  return `expired ${ago} ${ago === 1 ? "day" : "days"} ago`
}

/** The short flag the Organizations list shows beside an organization, or null without a date. */
export function priceContractBadge(
  validUntil: string | null | undefined,
  today: string,
): { status: Exclude<PriceContractStatus, "none">; label: string } | null {
  const status = priceContractStatus(validUntil, today)
  if (status === "none" || !validUntil) return null
  if (status === "expired") return { status, label: "Price contract expired" }
  if (status === "expiring") {
    const daysLeft = priceContractDaysLeft(validUntil, today)
    return { status, label: daysLeft === 0 ? "Contract expires today" : `Contract ${priceContractDaysLabel(daysLeft)}` }
  }
  return { status, label: `Prices valid to ${formatPriceContractDay(validUntil)}` }
}

export type PriceContractReminderPayload = {
  organizationId: number
  organizationName: string
  organizationCode: string | null
  validUntil: string
}

/** The reminder's wording, shared by the in-app notice and the email. */
export function priceContractReminderCopy(payload: PriceContractReminderPayload, daysLeft: number) {
  const day = formatPriceContractDay(payload.validUntil)
  return {
    title: "Price contract expiring",
    subject: `Price contract for ${payload.organizationName} ${priceContractDaysLabel(daysLeft)}`,
    message: `${payload.organizationName}'s price contract ${priceContractDaysLabel(daysLeft)} (valid until ${day}). Please review its prices.`,
    intro: `The agreed prices for ${payload.organizationName} are valid until ${day}. Please review them and record a new validity date once the contract is renewed. Ordering is not affected.`,
  }
}

/** Read an outbox payload back, or null when it is malformed. */
export function parsePriceContractReminderPayload(value: Record<string, unknown> | null | undefined): PriceContractReminderPayload | null {
  const organizationId = Number(value?.organizationId)
  if (
    !Number.isInteger(organizationId) || organizationId <= 0 ||
    typeof value?.organizationName !== "string" || !value.organizationName ||
    typeof value?.validUntil !== "string" || !isPriceContractCalendarDay(value.validUntil)
  ) {
    return null
  }
  return {
    organizationId,
    organizationName: value.organizationName,
    organizationCode: typeof value.organizationCode === "string" ? value.organizationCode : null,
    validUntil: value.validUntil,
  }
}

/** The Karachi calendar day of an instant, as `YYYY-MM-DD`. */
export function karachiCalendarDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}
