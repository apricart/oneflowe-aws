import { describe, expect, it } from "vitest"

import {
  addonPeriodsOpenAt,
  addonValidityBounds,
  formatAddonValidUntil,
  isAddonDue,
  openAddons,
  planAddonSettlement,
  remainingCents,
  resolveAddonValidUntil,
  type BudgetLedger,
  type OpenBudgetAddon,
} from "./budget-addon-expiry"

const NOW = new Date("2026-09-19T10:00:00.000Z") // 15:00 in Karachi, 19 Sep
const PERIOD = "2026-09"

function ledger(overrides: Partial<BudgetLedger> = {}): BudgetLedger {
  return {
    amountAllocatedCents: 100_000,
    amountSpentCents: 0,
    amountHeldCents: 0,
    amountCreditedCents: 0,
    ...overrides,
  }
}

function addon(overrides: Partial<OpenBudgetAddon> & { id: number }): OpenBudgetAddon {
  return {
    amountCents: 10_000,
    validUntil: new Date("2026-09-18T18:59:59.999Z"), // end of 18 Sep, Karachi
    expiredAt: null,
    ...overrides,
  }
}

/** The invariant the check constraint enforces, restated for the plan. */
function invariantHolds(before: BudgetLedger, creditedAfter: number) {
  return before.amountAllocatedCents + creditedAfter >= before.amountSpentCents + before.amountHeldCents
    && creditedAfter >= 0
}

describe("isAddonDue", () => {
  it("is due once the validity instant has passed", () => {
    expect(isAddonDue(addon({ id: 1 }), NOW)).toBe(true)
    expect(isAddonDue(addon({ id: 1, validUntil: NOW }), NOW)).toBe(true)
    expect(isAddonDue(addon({ id: 1, validUntil: new Date(NOW.getTime() + 1) }), NOW)).toBe(false)
  })

  it("never comes due for a legacy add-on without a date, or one already settled", () => {
    expect(isAddonDue(addon({ id: 1, validUntil: null }), NOW)).toBe(false)
    expect(isAddonDue(addon({ id: 1, expiredAt: new Date("2026-09-18T19:00:00.000Z") }), NOW)).toBe(false)
  })
})

describe("planAddonSettlement — the ceiling model", () => {
  it("withdraws nothing when nothing is due", () => {
    const plan = planAddonSettlement(
      ledger({ amountCreditedCents: 10_000 }),
      [addon({ id: 1, validUntil: new Date("2026-09-25T18:59:59.999Z") })],
      NOW,
    )
    expect(plan.forfeits).toEqual([])
    expect(plan.withdrawnCents).toBe(0)
    expect(plan.creditedAfterCents).toBe(10_000)
  })

  it("withdraws the whole add-on when the branch never reached into it", () => {
    const before = ledger({ amountCreditedCents: 10_000, amountSpentCents: 30_000 })
    const plan = planAddonSettlement(before, [addon({ id: 1 })], NOW)
    expect(plan.forfeits).toEqual([{ addonId: 1, amountCents: 10_000, forfeitedCents: 10_000 }])
    expect(plan.creditedAfterCents).toBe(0)
    expect(plan.remainingAfterCents).toBe(70_000)
    expect(invariantHolds(before, plan.creditedAfterCents)).toBe(true)
  })

  it("caps the withdrawal at what the branch still has remaining", () => {
    // base 100k, add-on 10k, spent 95k + held 8k = 103k: 7k remaining, so 3k of the add-on was needed.
    const before = ledger({ amountCreditedCents: 10_000, amountSpentCents: 95_000, amountHeldCents: 8_000 })
    const plan = planAddonSettlement(before, [addon({ id: 1 })], NOW)
    expect(plan.forfeits).toEqual([{ addonId: 1, amountCents: 10_000, forfeitedCents: 7_000 }])
    expect(plan.creditedAfterCents).toBe(3_000)
    expect(plan.remainingAfterCents).toBe(0)
    expect(invariantHolds(before, plan.creditedAfterCents)).toBe(true)
  })

  it("closes a fully consumed add-on with a zero forfeit rather than leaving it open", () => {
    const before = ledger({ amountCreditedCents: 10_000, amountSpentCents: 110_000 })
    const plan = planAddonSettlement(before, [addon({ id: 1 })], NOW)
    expect(plan.forfeits).toEqual([{ addonId: 1, amountCents: 10_000, forfeitedCents: 0 }])
    expect(plan.creditedAfterCents).toBe(10_000)
    expect(invariantHolds(before, plan.creditedAfterCents)).toBe(true)
  })

  it("treats a negative remaining as nothing to withdraw", () => {
    const before = ledger({ amountAllocatedCents: 50_000, amountCreditedCents: 10_000, amountSpentCents: 70_000 })
    const plan = planAddonSettlement(before, [addon({ id: 1 })], NOW)
    expect(plan.withdrawnCents).toBe(0)
    expect(plan.creditedAfterCents).toBe(10_000)
  })

  it("closes earlier validity first and shares the cap down the walk", () => {
    // 12k remaining; A (8k, older date) takes 8k, B (10k) gets the 4k that is left.
    const before = ledger({ amountCreditedCents: 18_000, amountSpentCents: 106_000 })
    const later = addon({ id: 2, amountCents: 10_000, validUntil: new Date("2026-09-19T05:00:00.000Z") })
    const earlier = addon({ id: 1, amountCents: 8_000 })
    const plan = planAddonSettlement(before, [later, earlier], NOW)
    expect(plan.forfeits).toEqual([
      { addonId: 1, amountCents: 8_000, forfeitedCents: 8_000 },
      { addonId: 2, amountCents: 10_000, forfeitedCents: 4_000 },
    ])
    expect(plan.withdrawnCents).toBe(12_000)
    expect(plan.creditedAfterCents).toBe(6_000)
    expect(plan.remainingAfterCents).toBe(0)
    expect(invariantHolds(before, plan.creditedAfterCents)).toBe(true)
  })

  it("breaks a tie on id so the walk is deterministic", () => {
    const before = ledger({ amountCreditedCents: 20_000, amountSpentCents: 115_000 })
    const plan = planAddonSettlement(before, [addon({ id: 7 }), addon({ id: 3 })], NOW)
    expect(plan.forfeits.map((forfeit) => forfeit.addonId)).toEqual([3, 7])
    expect(plan.forfeits.map((forfeit) => forfeit.forfeitedCents)).toEqual([5_000, 0])
  })

  it("leaves legacy and already-settled add-ons alone", () => {
    const before = ledger({ amountCreditedCents: 30_000 })
    const plan = planAddonSettlement(before, [
      addon({ id: 1, validUntil: null }),
      addon({ id: 2, expiredAt: new Date("2026-09-10T00:00:00.000Z") }),
      addon({ id: 3 }),
    ], NOW)
    expect(plan.forfeits.map((forfeit) => forfeit.addonId)).toEqual([3])
    expect(plan.creditedAfterCents).toBe(20_000)
  })

  it("never withdraws more than is credited, whatever the row says", () => {
    // A hand-repaired row where credited is below the open add-on total.
    const before = ledger({ amountCreditedCents: 4_000 })
    const plan = planAddonSettlement(before, [addon({ id: 1, amountCents: 10_000 })], NOW)
    expect(plan.forfeits).toEqual([{ addonId: 1, amountCents: 10_000, forfeitedCents: 4_000 }])
    expect(plan.creditedAfterCents).toBe(0)
  })

  it("closeAll closes every open add-on regardless of date — the reset path", () => {
    const before = ledger({ amountCreditedCents: 30_000, amountSpentCents: 20_000 })
    const plan = planAddonSettlement(before, [
      addon({ id: 1, validUntil: null }),
      addon({ id: 2, validUntil: new Date("2026-09-30T18:59:59.999Z") }),
      addon({ id: 3, expiredAt: new Date("2026-09-10T00:00:00.000Z") }),
    ], NOW, { closeAll: true })
    expect(plan.forfeits.map((forfeit) => forfeit.addonId)).toEqual([2, 1])
    expect(plan.withdrawnCents).toBe(20_000)
    expect(invariantHolds(before, plan.creditedAfterCents)).toBe(true)
  })
})

describe("resolveAddonValidUntil", () => {
  it("resolves a day to its last instant in Asia/Karachi", () => {
    const result = resolveAddonValidUntil("2026-09-25", NOW)
    expect(result).toEqual({ ok: true, validUntil: new Date("2026-09-25T18:59:59.999Z"), period: PERIOD })
  })

  it("accepts today and the last day of the month", () => {
    expect(resolveAddonValidUntil("2026-09-19", NOW).ok).toBe(true)
    expect(resolveAddonValidUntil("2026-09-30", NOW).ok).toBe(true)
  })

  it("accepts today even late in the Karachi evening when UTC has moved on", () => {
    // 23:30 on 19 Sep in Karachi is 18:30Z; the day still has half an hour.
    const lateEvening = new Date("2026-09-19T18:30:00.000Z")
    expect(resolveAddonValidUntil("2026-09-19", lateEvening).ok).toBe(true)
    // 00:30 on 20 Sep in Karachi is 19:30Z on 19 Sep in UTC: the 19th has gone.
    const pastMidnight = new Date("2026-09-19T19:30:00.000Z")
    expect(resolveAddonValidUntil("2026-09-19", pastMidnight)).toMatchObject({ ok: false })
  })

  it("refuses a day that has passed", () => {
    expect(resolveAddonValidUntil("2026-09-18", NOW)).toEqual({
      ok: false,
      error: "validUntil must be today or a later date",
    })
  })

  it("refuses a day outside the current budget month", () => {
    expect(resolveAddonValidUntil("2026-10-01", NOW)).toEqual({
      ok: false,
      error: "validUntil must fall within the current budget month",
    })
    expect(resolveAddonValidUntil("2026-08-31", NOW)).toMatchObject({ ok: false })
  })

  describe("the first hours of a month, when the engine still bills the old one", () => {
    // 01:00 on 1 Oct in Karachi is 20:00Z on 30 Sep: the UTC period is still September.
    const smallHours = new Date("2026-09-30T20:00:00.000Z")

    it("opens both months, and only then", () => {
      expect(addonPeriodsOpenAt(smallHours)).toEqual(["2026-09", "2026-10"])
      expect(addonPeriodsOpenAt(NOW)).toEqual(["2026-09"])
      // 05:00 Karachi: the engine has rolled over and only October is open.
      expect(addonPeriodsOpenAt(new Date("2026-10-01T00:00:00.000Z"))).toEqual(["2026-10"])
    })

    it("files an October date on October's row instead of refusing it", () => {
      expect(resolveAddonValidUntil("2026-10-05", smallHours)).toEqual({
        ok: true,
        validUntil: new Date("2026-10-05T18:59:59.999Z"),
        period: "2026-10",
      })
      expect(resolveAddonValidUntil("2026-10-01", smallHours)).toMatchObject({ ok: true, period: "2026-10" })
    })

    it("still refuses September, whose last day has ended, and November", () => {
      expect(resolveAddonValidUntil("2026-09-30", smallHours)).toEqual({
        ok: false,
        error: "validUntil must be today or a later date",
      })
      expect(resolveAddonValidUntil("2026-11-01", smallHours)).toEqual({
        ok: false,
        error: "validUntil must fall within the current budget month",
      })
    })
  })

  it("refuses malformed input and impossible calendar days", () => {
    for (const value of ["25-09-2026", "2026-9-25", "2026-09-25T00:00:00Z", "", null, undefined, 20260925]) {
      expect(resolveAddonValidUntil(value, NOW)).toMatchObject({ ok: false })
    }
    expect(resolveAddonValidUntil("2026-09-31", NOW)).toEqual({
      ok: false,
      error: "validUntil is not a valid calendar date",
    })
  })
})

describe("openAddons / remainingCents", () => {
  it("lists only add-ons still in force", () => {
    const inForce = addon({ id: 1, validUntil: new Date("2026-09-25T18:59:59.999Z") })
    const legacy = addon({ id: 2, validUntil: null })
    const due = addon({ id: 3 })
    const settled = addon({ id: 4, expiredAt: NOW })
    expect(openAddons([inForce, legacy, due, settled], NOW)).toEqual([inForce, legacy])
  })

  it("computes remaining as allocated + credited − spent − held", () => {
    expect(remainingCents(ledger({ amountCreditedCents: 5, amountSpentCents: 40, amountHeldCents: 10 }))).toBe(99_955)
  })
})

describe("addonValidityBounds / formatAddonValidUntil", () => {
  it("offers today through the last day of the administrator's month", () => {
    expect(addonValidityBounds(NOW)).toEqual({ min: "2026-09-19", max: "2026-09-30" })
    expect(addonValidityBounds(new Date("2026-02-03T00:00:00.000Z"))).toEqual({ min: "2026-02-03", max: "2026-02-28" })
  })

  it("reads the Karachi calendar, not UTC, so the picker follows the month the administrator is in", () => {
    // 20:00Z on 19 Sep is already 01:00 on 20 Sep in Karachi.
    expect(addonValidityBounds(new Date("2026-09-19T20:00:00.000Z")).min).toBe("2026-09-20")
    // 20:00Z on 30 Sep is 01:00 on 1 Oct in Karachi: the picker offers October.
    expect(addonValidityBounds(new Date("2026-09-30T20:00:00.000Z"))).toEqual({ min: "2026-10-01", max: "2026-10-31" })
  })

  it("labels the validity instant by its Karachi day", () => {
    expect(formatAddonValidUntil("2026-09-25T18:59:59.999Z")).toBe("25 Sept 2026")
    expect(formatAddonValidUntil(new Date("2026-09-25T18:59:59.999Z"))).toBe("25 Sept 2026")
    expect(formatAddonValidUntil(null)).toBeNull()
    expect(formatAddonValidUntil("not a date")).toBeNull()
  })
})
