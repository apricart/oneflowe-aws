import { describe, expect, it } from "vitest"

import {
  EMPTY_SUPPORT_STATS,
  formatResponseDuration,
  normalizeSupportStats,
  supportStatCards,
  type SupportStats,
} from "./support-stats"
import { SUPPORT_STATUSES } from "./support-thread"

function stats(overrides: Partial<SupportStats> = {}): SupportStats {
  return { ...EMPTY_SUPPORT_STATS, ...overrides }
}

describe("normalizeSupportStats", () => {
  it("reads the numeric strings the Postgres driver returns for counts", () => {
    // `count(*)` comes back as a bigint, which node-postgres hands over as a
    // string. A tile rendering "NaN" is the failure this guards.
    const result = normalizeSupportStats({
      total: "42",
      open: "7",
      avgFirstResponseMinutes: "125.5",
    })

    expect(result.total).toBe(42)
    expect(result.open).toBe(7)
    expect(result.avgFirstResponseMinutes).toBeCloseTo(125.5)
  })

  it("falls back to zero rather than NaN for anything unreadable", () => {
    const result = normalizeSupportStats({
      total: "not a number",
      open: null,
      resolved: undefined,
      closed: -3,
      unread: {},
    })

    expect(result).toEqual(EMPTY_SUPPORT_STATS)
  })

  it("survives a missing, null or non-object payload", () => {
    expect(normalizeSupportStats(undefined)).toEqual(EMPTY_SUPPORT_STATS)
    expect(normalizeSupportStats(null)).toEqual(EMPTY_SUPPORT_STATS)
    expect(normalizeSupportStats({})).toEqual(EMPTY_SUPPORT_STATS)
  })

  it("reports no average rather than zero when nothing has been answered", () => {
    // Zero would read as an instant reply; null is the honest answer and shows
    // as an em dash.
    expect(normalizeSupportStats({ avgFirstResponseMinutes: null }).avgFirstResponseMinutes)
      .toBeNull()
    expect(normalizeSupportStats({}).avgFirstResponseMinutes).toBeNull()
  })
})

describe("formatResponseDuration", () => {
  it("shows an em dash when there is nothing to average", () => {
    expect(formatResponseDuration(null)).toBe("—")
    expect(formatResponseDuration(undefined)).toBe("—")
    expect(formatResponseDuration(Number.NaN)).toBe("—")
    expect(formatResponseDuration(-5)).toBe("—")
  })

  it("keeps sub-minute replies distinguishable from no data", () => {
    expect(formatResponseDuration(0)).toBe("< 1m")
    expect(formatResponseDuration(0.4)).toBe("< 1m")
  })

  it("reads in the largest two units that carry meaning", () => {
    expect(formatResponseDuration(1)).toBe("1m")
    expect(formatResponseDuration(59)).toBe("59m")
    expect(formatResponseDuration(60)).toBe("1h")
    expect(formatResponseDuration(90)).toBe("1h 30m")
    expect(formatResponseDuration(60 * 24)).toBe("1d")
    expect(formatResponseDuration(60 * 24 + 120)).toBe("1d 2h")
    expect(formatResponseDuration(60 * 24 * 9 + 60)).toBe("9d 1h")
  })

  it("rounds to the minute rather than printing a fraction", () => {
    expect(formatResponseDuration(12.6)).toBe("13m")
  })
})

describe("supportStatCards", () => {
  it("gives each side six tiles", () => {
    expect(supportStatCards(stats(), "APRICART")).toHaveLength(6)
    expect(supportStatCards(stats(), "CUSTOMER")).toHaveLength(6)
  })

  it("shows Apricart the operator's figures", () => {
    const cards = supportStatCards(
      stats({ total: 90, open: 12, unanswered: 4, urgent: 3, avgFirstResponseMinutes: 135 }),
      "APRICART",
    )
    const byKey = Object.fromEntries(cards.map((card) => [card.key, card]))

    expect(byKey.open.label).toBe("Needs a reply")
    expect(byKey.open.value).toBe(12)
    expect(byKey.unanswered.value).toBe(4)
    expect(byKey.urgent.value).toBe(3)
    expect(byKey.firstResponse.value).toBe("2h 15m")
  })

  it("shows a client its own figures and never Apricart's response time", () => {
    const cards = supportStatCards(
      stats({ total: 5, open: 2, awaitingCustomer: 1, unread: 3, openedLast7Days: 4 }),
      "CUSTOMER",
    )
    const keys = cards.map((card) => card.key)

    expect(keys).toContain("awaiting")
    expect(keys).toContain("unread")
    expect(keys).toContain("recent")
    expect(keys).not.toContain("firstResponse")
    expect(keys).not.toContain("unanswered")
    expect(keys).not.toContain("urgent")

    const byKey = Object.fromEntries(cards.map((card) => [card.key, card]))
    expect(byKey.open.label).toBe("Open")
    expect(byKey.awaiting.value).toBe(1)
    expect(byKey.recent.value).toBe(4)
  })

  it("reads the same status differently on each side", () => {
    const apricart = supportStatCards(stats(), "APRICART").find((card) => card.key === "open")
    const customer = supportStatCards(stats(), "CUSTOMER").find((card) => card.key === "open")

    expect(apricart?.statusFilter).toBe("OPEN")
    expect(customer?.statusFilter).toBe("OPEN")
    expect(apricart?.label).not.toBe(customer?.label)
  })

  it("only offers a filter where the tile counts exactly that status", () => {
    // A tile that filtered to something narrower than its own number would
    // show a count of 20 and then a list of 12.
    for (const side of ["APRICART", "CUSTOMER"] as const) {
      const source = stats({
        total: 100,
        open: 10,
        awaitingCustomer: 20,
        resolved: 30,
        closed: 40,
        unread: 6,
        urgent: 2,
        unanswered: 3,
        openedLast7Days: 8,
      })
      const counts: Record<string, number> = {
        OPEN: source.open,
        AWAITING_CUSTOMER: source.awaitingCustomer,
        RESOLVED: source.resolved,
        CLOSED: source.closed,
      }

      for (const card of supportStatCards(source, side)) {
        if (!card.statusFilter) continue
        expect(SUPPORT_STATUSES).toContain(card.statusFilter)
        expect(card.value, `${side}/${card.key} must count its own filter`).toBe(
          counts[card.statusFilter],
        )
      }
    }
  })

  it("never leaves a tile without a label or a subtitle", () => {
    for (const side of ["APRICART", "CUSTOMER"] as const) {
      for (const card of supportStatCards(stats(), side)) {
        expect(card.label.length).toBeGreaterThan(0)
        expect(card.subtitle.length).toBeGreaterThan(0)
      }
    }
  })
})
