/**
 * One-time add-on budgets with a validity date — the pure part.
 *
 * A branch has one pooled money budget for the month:
 *
 *   remaining = allocated + credited − spent − held
 *
 * An add-on raises `credited` until its validity date. When that instant
 * passes, the unspent part of the add-on is withdrawn from `credited` again.
 * "Unspent" follows the ceiling model decided in
 * plans/OF-BUDGET-addon-validity.md: the base allocation is spent first, so
 * the withdrawal is whatever of the add-on is still remaining — capped at
 * what the branch has left, so spent and held are never touched and
 * `allocated + credited >= spent + held` keeps holding.
 *
 * Nothing here reads a clock or a database; the server module in
 * lib/server/budget-addon-expiry.ts applies the plan under a row lock.
 */
import { getAppMonthPeriod, parseEndDateParam } from "@/lib/date-range-params"

export const ADDON_VALID_UNTIL_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export type BudgetLedger = {
  amountAllocatedCents: number
  amountSpentCents: number
  amountHeldCents: number
  amountCreditedCents: number
}

export type OpenBudgetAddon = {
  id: number
  amountCents: number
  validUntil: Date | null
  expiredAt: Date | null
}

export type AddonForfeit = {
  addonId: number
  amountCents: number
  forfeitedCents: number
}

export type AddonSettlementPlan = {
  /** Add-ons the walk closed, in the order they were closed. */
  forfeits: AddonForfeit[]
  /** Sum of every forfeit — what comes off `amountCreditedCents`. */
  withdrawnCents: number
  creditedBeforeCents: number
  creditedAfterCents: number
  remainingBeforeCents: number
  remainingAfterCents: number
}

export function remainingCents(ledger: BudgetLedger): number {
  return ledger.amountAllocatedCents + ledger.amountCreditedCents
    - ledger.amountSpentCents - ledger.amountHeldCents
}

/** An add-on is due once its validity instant is at or before `now`. A legacy row (no date) never is. */
export function isAddonDue(addon: Pick<OpenBudgetAddon, "validUntil" | "expiredAt">, now: Date): boolean {
  if (addon.expiredAt) return false
  if (!addon.validUntil) return false
  return addon.validUntil.getTime() <= now.getTime()
}

/**
 * Plan the withdrawal for every add-on on one budget row that is due at
 * `now`. Earlier validity closes first; ties break on id so the walk is
 * deterministic. Each add-on forfeits what is left of it, capped at what the
 * branch still has remaining, and the cap is shared down the walk.
 *
 * `closeAll` closes every open add-on regardless of its date — the reset
 * path uses it so an Empty never leaves an add-on looking live in the ledger.
 */
export function planAddonSettlement(
  ledger: BudgetLedger,
  addons: OpenBudgetAddon[],
  now: Date,
  options: { closeAll?: boolean } = {},
): AddonSettlementPlan {
  const due = addons
    .filter((addon) => options.closeAll ? !addon.expiredAt : isAddonDue(addon, now))
    .sort((a, b) => {
      const aTime = a.validUntil?.getTime() ?? Number.POSITIVE_INFINITY
      const bTime = b.validUntil?.getTime() ?? Number.POSITIVE_INFINITY
      return aTime - bTime || a.id - b.id
    })

  const creditedBeforeCents = ledger.amountCreditedCents
  const remainingBeforeCents = remainingCents(ledger)
  let remaining = Math.max(0, remainingBeforeCents)
  let credited = creditedBeforeCents
  const forfeits: AddonForfeit[] = []

  for (const addon of due) {
    const amount = Math.max(0, Math.trunc(addon.amountCents))
    const forfeitedCents = Math.max(0, Math.min(amount, remaining, credited))
    remaining -= forfeitedCents
    credited -= forfeitedCents
    forfeits.push({ addonId: addon.id, amountCents: amount, forfeitedCents })
  }

  const withdrawnCents = forfeits.reduce((sum, forfeit) => sum + forfeit.forfeitedCents, 0)
  return {
    forfeits,
    withdrawnCents,
    creditedBeforeCents,
    creditedAfterCents: creditedBeforeCents - withdrawnCents,
    remainingBeforeCents,
    remainingAfterCents: remainingBeforeCents - withdrawnCents,
  }
}

export type ValidUntilResolution =
  | { ok: true; validUntil: Date; period: string }
  | { ok: false; error: string }

/**
 * The budget months an add-on may be filed under at `now`: the UTC `YYYY-MM`
 * the ordering engine bills against, and the Asia/Karachi month the
 * administrator is living in. They are the same month except between
 * midnight and 05:00 Karachi on the first of a month, when the engine still
 * bills last month; an add-on granted then is filed on the new month's row,
 * where it becomes spendable the moment the engine rolls over, rather than
 * being refused or dying five hours later on a superseded row.
 */
export function addonPeriodsOpenAt(now: Date): string[] {
  return Array.from(new Set([now.toISOString().slice(0, 7), getAppMonthPeriod(now)]))
}

/**
 * Turn the administrator's `YYYY-MM-DD` into the instant the add-on stops
 * being available — 23:59:59.999 on that day, Asia/Karachi — and the
 * `YYYY-MM` budget row it is filed on. The day must not have passed and its
 * month must be one `addonPeriodsOpenAt` allows: add-ons live on the monthly
 * row and reset with it, so a date in any other month could never be
 * honoured.
 */
export function resolveAddonValidUntil(value: unknown, now: Date): ValidUntilResolution {
  if (typeof value !== "string" || !ADDON_VALID_UNTIL_PATTERN.test(value)) {
    return { ok: false, error: "validUntil must be a date in YYYY-MM-DD format" }
  }
  // The Date parser rolls "2026-02-31" into March; refuse a day the calendar
  // does not have before it gets the chance.
  if (!isCalendarDay(value)) {
    return { ok: false, error: "validUntil is not a valid calendar date" }
  }
  const validUntil = parseEndDateParam(value)
  if (!validUntil || Number.isNaN(validUntil.getTime())) {
    return { ok: false, error: "validUntil is not a valid calendar date" }
  }
  if (validUntil.getTime() <= now.getTime()) {
    return { ok: false, error: "validUntil must be today or a later date" }
  }
  const period = value.slice(0, 7)
  if (!addonPeriodsOpenAt(now).includes(period)) {
    return { ok: false, error: "validUntil must fall within the current budget month" }
  }
  return { ok: true, validUntil, period }
}

function isCalendarDay(day: string): boolean {
  const [year, month, date] = day.split("-").map(Number)
  const probe = new Date(Date.UTC(year, month - 1, date))
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === date
}

/** Which of a budget's add-ons are still in force at `now` — the list the UI shows. */
export function openAddons<T extends Pick<OpenBudgetAddon, "validUntil" | "expiredAt">>(addons: T[], now: Date): T[] {
  return addons.filter((addon) => !addon.expiredAt && !isAddonDue(addon, now))
}

const appDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Karachi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

const appDayLabelFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  day: "numeric",
  month: "short",
  year: "numeric",
})

/**
 * The calendar range the validity picker offers: today in Asia/Karachi up to
 * the last day of the latest month `addonPeriodsOpenAt` allows — the
 * administrator's own month. The server bounds the value again; this only
 * keeps the picker honest.
 */
export function addonValidityBounds(now: Date): { min: string; max: string } {
  const period = getAppMonthPeriod(now)
  const [year, month] = period.split("-").map(Number)
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return {
    min: appDayFormatter.format(now),
    max: `${period}-${String(lastDay).padStart(2, "0")}`,
  }
}

/** "25 Sep 2026" for the instant an add-on stops being available, in the app's calendar. */
export function formatAddonValidUntil(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return appDayLabelFormatter.format(date)
}
