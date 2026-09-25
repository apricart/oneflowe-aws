import { describe, expect, it } from "vitest"

import {
  BUDGET_BURN_DEFAULT_ROWS,
  BUDGET_BURN_MAX_MONTHS_BACK,
  BUDGET_BURN_MAX_ROWS,
  BUDGET_BURN_PATTERN_MONTHS,
  BUDGET_BURN_POINTS,
  BUDGET_BURN_REASONS,
  BUDGET_BURN_REASON_LABELS,
  BUDGET_BURN_THRESHOLDS,
  appDayKey,
  branchUtilizationPct,
  buildWatchlist,
  clampWatchlistLimit,
  consumedCents,
  creatorKey,
  currentAppMonth,
  emptyMonthConsumption,
  isBudgetBurnRole,
  isMonthKey,
  isMonthWindowError,
  isScoreFlagged,
  monthConsumptionOf,
  monthOverMonth,
  monthWindows,
  monthsBetween,
  patternByCreator,
  peerBranchMedianUtilizationPct,
  rankWatchlist,
  scoreRequester,
  summarizeCreators,
  unionCreators,
  type BranchMonth,
  type CreatorMonth,
  type MonthConsumption,
  type MonthWindows,
} from "./budget-burn-risk"

const T = BUDGET_BURN_THRESHOLDS
const DAY = 86_400_000

/** A Karachi wall-clock instant. */
function karachi(day: string, time = "12:00:00"): Date {
  return new Date(`${day}T${time}.000+05:00`)
}

function windows(month: string, now: Date): MonthWindows {
  const result = monthWindows(month, now)
  if (isMonthWindowError(result)) throw new Error(result.error)
  return result
}

function requester(overrides: Partial<CreatorMonth> & Pick<CreatorMonth, "userId">): CreatorMonth {
  return {
    branchId: 1,
    role: "ORDER_PORTAL",
    spendCents: 0,
    pendingCents: 0,
    orderCount: 0,
    pendingOrderCount: 0,
    rejectedOrderCount: 0,
    recentConsumedCents: 0,
    ...overrides,
  }
}

function branch(overrides: Partial<BranchMonth> = {}): BranchMonth {
  return {
    branchId: 1,
    consumedCents: 10_000_000,
    otherCreatorsConsumedCents: 0,
    activeRequesterCount: 3,
    totalBudgetCents: 20_000_000,
    remainingCents: 10_000_000,
    ...overrides,
  }
}

const PATTERN_MONTHS = ["2026-06", "2026-07", "2026-08"]

/** A pattern from consumed figures, oldest first — the shape the panel draws. */
function months(...consumed: number[]): MonthConsumption[] {
  return consumed.map((value, index) => ({
    month: PATTERN_MONTHS[index] ?? `2026-${String(index + 1).padStart(2, "0")}`,
    spendCents: value,
    pendingCents: 0,
    consumedCents: value,
  }))
}

/** Three ordinarily utilized peer branches; their median matches `branch()` at 50%. */
const ordinaryPeerBranches = [
  branch({ branchId: 2, consumedCents: 4_000_000, totalBudgetCents: 10_000_000 }),
  branch({ branchId: 3, consumedCents: 5_000_000, totalBudgetCents: 10_000_000 }),
  branch({ branchId: 4, consumedCents: 6_000_000, totalBudgetCents: 10_000_000 }),
]

describe("role gate", () => {
  it("admits Super Admin and Head Office only", () => {
    expect(isBudgetBurnRole("SUPER_ADMIN")).toBe(true)
    expect(isBudgetBurnRole("HEAD_OFFICE")).toBe(true)
    // The approver reads the Center but not, for now, a list that names people;
    // the single-branch and ordering roles have no Center at all.
    for (const role of ["GROUP_USER", "BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_ORDER_PORTAL", "head_office", "", null, undefined, 3]) {
      expect(isBudgetBurnRole(role), String(role)).toBe(false)
    }
  })
})

describe("bounds", () => {
  it("clamps the row limit to a default and a maximum", () => {
    expect(clampWatchlistLimit(undefined)).toBe(BUDGET_BURN_DEFAULT_ROWS)
    expect(clampWatchlistLimit("0")).toBe(BUDGET_BURN_DEFAULT_ROWS)
    expect(clampWatchlistLimit("-4")).toBe(BUDGET_BURN_DEFAULT_ROWS)
    expect(clampWatchlistLimit("abc")).toBe(BUDGET_BURN_DEFAULT_ROWS)
    expect(clampWatchlistLimit("10")).toBe(10)
    expect(clampWatchlistLimit("10.9")).toBe(10)
    expect(clampWatchlistLimit("999")).toBe(BUDGET_BURN_MAX_ROWS)
  })

  it("names every reason once, with a label and a point value", () => {
    expect(BUDGET_BURN_REASONS).toEqual(["high_share", "mom_spike", "above_peers", "late_surge", "high_held", "rejected_orders"])
    for (const reason of BUDGET_BURN_REASONS) {
      expect(BUDGET_BURN_POINTS[reason]).toBeGreaterThan(0)
      expect(BUDGET_BURN_REASON_LABELS[reason].length).toBeGreaterThan(0)
    }
  })
})

describe("the calendar", () => {
  it("accepts only YYYY-MM keys", () => {
    expect(isMonthKey("2026-09")).toBe(true)
    for (const bad of ["2026-13", "2026-00", "2026-9", "202609", "2026-09-01", "", null, 7]) {
      expect(isMonthKey(bad), String(bad)).toBe(false)
    }
  })

  it("reads the current month in Karachi, not the server zone", () => {
    // 21:30 UTC on 31 Aug is 02:30 on 1 Sep in Karachi.
    expect(currentAppMonth(new Date("2026-08-31T21:30:00.000Z"))).toBe("2026-09")
    expect(currentAppMonth(new Date("2026-08-31T18:30:00.000Z"))).toBe("2026-08")
  })

  it("counts months between keys across a year boundary", () => {
    expect(monthsBetween("2025-11", "2026-02")).toBe(3)
    expect(monthsBetween("2026-02", "2025-11")).toBe(-3)
    expect(monthsBetween("2026-09", "2026-09")).toBe(0)
  })

  it("builds a month-to-date window that ends now", () => {
    const now = karachi("2026-09-20", "15:00:00")
    const w = windows("2026-09", now)
    expect(w.current.start.toISOString()).toBe("2026-08-31T19:00:00.000Z") // 1 Sep 00:00 +05:00
    expect(w.current.end).toEqual(now)
    expect(w.current.complete).toBe(false)
    expect(w.current.elapsedDays).toBe(20)
    expect(w.current.daysInMonth).toBe(30)
    // The last seven days, ending now.
    expect(w.recent.end).toEqual(now)
    expect(w.recent.start.toISOString()).toBe(new Date(now.getTime() - T.lateSurgeDays * DAY).toISOString())
  })

  it("closes the month window at the last instant once the month is over", () => {
    const w = windows("2026-08", karachi("2026-09-20"))
    expect(w.current.complete).toBe(true)
    expect(w.current.elapsedDays).toBe(31)
    expect(w.current.end.toISOString()).toBe("2026-08-31T18:59:59.999Z")
    // Seven days back from the last instant of August lands on the last instant
    // of 24 August, so the recent window is 25–31 August.
    expect(w.recent.start.toISOString()).toBe("2026-08-24T18:59:59.999Z")
  })

  it("draws one bucket per pattern month, oldest first, ending with the selection", () => {
    const w = windows("2026-08", karachi("2026-09-20"))
    expect(w.pattern).toHaveLength(BUDGET_BURN_PATTERN_MONTHS)
    expect(w.pattern.map((bucket) => bucket.month)).toEqual(["2026-06", "2026-07", "2026-08"])
    expect(w.pattern.at(-1)!.month).toBe(w.month)
    // The newest bucket is the month window itself — one read serves both.
    expect(w.pattern.at(-1)!.start).toEqual(w.current.start)
    expect(w.pattern.at(-1)!.end).toEqual(w.current.end)
  })

  it("gives every bucket a whole month once the selected month is over", () => {
    const w = windows("2026-08", karachi("2026-09-20"))
    expect(w.pattern.map((bucket) => bucket.complete)).toEqual([true, true, true])
    expect(w.pattern[0].start.toISOString()).toBe("2026-05-31T19:00:00.000Z") // 1 Jun 00:00 +05:00
    expect(w.pattern[0].end.toISOString()).toBe("2026-06-30T18:59:59.999Z")
    expect(w.pattern[1].start.toISOString()).toBe("2026-06-30T19:00:00.000Z")
    expect(w.pattern[1].end.toISOString()).toBe("2026-07-31T18:59:59.999Z")
  })

  it("cuts the older buckets on the same elapsed day while the month is open", () => {
    const now = karachi("2026-09-20", "15:00:00")
    const w = windows("2026-09", now)
    expect(w.pattern.map((bucket) => bucket.month)).toEqual(["2026-07", "2026-08", "2026-09"])
    expect(w.pattern[0].end.toISOString()).toBe("2026-07-20T18:59:59.999Z") // 20 Jul 23:59:59.999 +05:00
    expect(w.pattern[1].end.toISOString()).toBe("2026-08-20T18:59:59.999Z")
    expect(w.pattern[2].end).toEqual(now)
    expect(w.pattern.map((bucket) => bucket.complete)).toEqual([false, false, false])
    // Both older buckets cover exactly the elapsed twenty days, so a mid-month
    // reading is never set against a full month.
    for (const bucket of w.pattern.slice(0, 2)) {
      expect(Math.round((bucket.end.getTime() - bucket.start.getTime()) / DAY), bucket.month).toBe(20)
    }
  })

  it("clamps an older bucket to a shorter month, and calls it complete when it covers one", () => {
    // 30 April to date; two months back is February, which has 28 days in 2026.
    const w = windows("2026-04", karachi("2026-04-30"))
    expect(w.current.elapsedDays).toBe(30)
    expect(w.pattern.map((bucket) => bucket.month)).toEqual(["2026-02", "2026-03", "2026-04"])
    expect(w.pattern[0].end.toISOString()).toBe("2026-02-28T18:59:59.999Z")
    // February is shorter than the elapsed day, so the bucket holds all of it.
    expect(w.pattern[0].complete).toBe(true)
    // March is longer, so its bucket stops on the 30th and is not whole.
    expect(w.pattern[1].end.toISOString()).toBe("2026-03-30T18:59:59.999Z")
    expect(w.pattern[1].complete).toBe(false)
  })

  it("steps the buckets back across the year boundary", () => {
    const w = windows("2026-01", karachi("2026-01-10"))
    expect(w.pattern.map((bucket) => bucket.month)).toEqual(["2025-11", "2025-12", "2026-01"])
    expect(w.pattern[0].end.toISOString()).toBe("2025-11-10T18:59:59.999Z")
    expect(w.pattern[1].end.toISOString()).toBe("2025-12-10T18:59:59.999Z")
  })

  it("never lets two buckets overlap, whatever the selection", () => {
    for (const [month, now] of [
      ["2026-09", karachi("2026-09-20", "23:59:59")],
      ["2026-08", karachi("2026-09-20")],
      ["2026-01", karachi("2026-01-10", "23:59:59")],
      ["2026-04", karachi("2026-04-30")],
    ] as const) {
      const w = windows(month, now)
      for (let index = 1; index < w.pattern.length; index += 1) {
        expect(w.pattern[index - 1].end.getTime(), `${month} bucket ${index}`)
          .toBeLessThan(w.pattern[index].start.getTime())
      }
    }
  })

  it("keeps the recent window inside the month early on", () => {
    const now = karachi("2026-09-03", "09:00:00")
    const w = windows("2026-09", now)
    expect(w.recent.start).toEqual(w.current.start)
    expect(w.current.elapsedDays).toBe(3)
  })

  it("treats 02:00 Karachi on the 1st as the new month, whatever UTC says", () => {
    const now = new Date("2026-08-31T21:00:00.000Z") // 1 Sep 02:00 +05:00
    const w = windows("2026-09", now)
    expect(w.current.complete).toBe(false)
    expect(w.current.elapsedDays).toBe(1)
    // And August is complete from that same instant.
    expect(windows("2026-08", now).current.complete).toBe(true)
  })

  it("refuses a future month, a malformed month and one too far back", () => {
    const now = karachi("2026-09-20")
    expect(monthWindows("2026-10", now)).toEqual({ ok: false, error: "month is in the future" })
    expect(monthWindows("2026-9", now)).toEqual({ ok: false, error: "month must be YYYY-MM" })
    const tooFar = monthWindows("2024-08", now)
    expect(isMonthWindowError(tooFar) && tooFar.error).toContain(String(BUDGET_BURN_MAX_MONTHS_BACK))
    // Exactly the limit is still allowed.
    expect(isMonthWindowError(monthWindows("2024-09", now))).toBe(false)
  })

  it("formats a day key in Karachi for the drill-down's date-only filters", () => {
    expect(appDayKey(new Date("2026-08-31T21:00:00.000Z"))).toBe("2026-09-01")
    expect(appDayKey(new Date("2026-08-31T18:00:00.000Z"))).toBe("2026-08-31")
  })
})

describe("summarising creators", () => {
  it("lists requesters only, but counts everyone toward the branch", () => {
    const rows: CreatorMonth[] = [
      requester({ userId: "ahmed", spendCents: 3_000_000 }),
      requester({ userId: "group", role: "GROUP_ORDER_PORTAL", spendCents: 1_000_000, pendingCents: 500_000 }),
      requester({ userId: "admin", role: "BRANCH_ADMIN", spendCents: 2_000_000 }),
      requester({ userId: "idle", spendCents: 0 }),
    ]
    const { requesters, branches } = summarizeCreators(rows, new Map([[1, { totalBudgetCents: 9_000_000, remainingCents: 2_500_000 }]]))
    expect(requesters.map((row) => row.userId)).toEqual(["ahmed", "group", "idle"])
    const b = branches.get(1)!
    expect(b.consumedCents).toBe(6_500_000)
    expect(b.otherCreatorsConsumedCents).toBe(2_000_000)
    expect(b.activeRequesterCount).toBe(2) // idle has nothing this month
    expect(b.totalBudgetCents).toBe(9_000_000)
    expect(b.remainingCents).toBe(2_500_000)
  })

  it("keeps a group requester separate per branch", () => {
    const rows = [
      requester({ userId: "group", role: "GROUP_ORDER_PORTAL", branchId: 1, spendCents: 100 }),
      requester({ userId: "group", role: "GROUP_ORDER_PORTAL", branchId: 2, spendCents: 200 }),
    ]
    const { requesters, branches } = summarizeCreators(rows)
    expect(requesters).toHaveLength(2)
    expect(branches.get(1)?.consumedCents).toBe(100)
    expect(branches.get(2)?.consumedCents).toBe(200)
    expect(creatorKey(rows[0])).not.toBe(creatorKey(rows[1]))
  })

  it("defaults a branch with no budget row to zero budget", () => {
    const { branches } = summarizeCreators([requester({ userId: "a", spendCents: 5 })])
    expect(branches.get(1)?.totalBudgetCents).toBe(0)
  })

  it("keeps a budgeted branch with no orders as a zero-utilization peer", () => {
    const { branches } = summarizeCreators(
      [requester({ userId: "a", branchId: 1, spendCents: 5 })],
      new Map([
        [1, { totalBudgetCents: 100, remainingCents: 95 }],
        [2, { totalBudgetCents: 200, remainingCents: 200 }],
        [3, { totalBudgetCents: 0, remainingCents: 0 }],
      ]),
    )
    expect(branches.get(2)).toMatchObject({ consumedCents: 0, totalBudgetCents: 200 })
    expect(branches.has(3)).toBe(false)
  })

  it("never lets a negative figure reduce consumption", () => {
    expect(consumedCents({ spendCents: -5, pendingCents: 10 })).toBe(10)
  })
})

describe("the union across the pattern", () => {
  const june = [requester({ userId: "gone", spendCents: 900_000 }), requester({ userId: "ahmed", spendCents: 11_000 })]
  const july = [requester({ userId: "ahmed", spendCents: 602_000 })]
  const august = [
    requester({ userId: "ahmed", spendCents: 2_200_000, pendingCents: 50_000, orderCount: 2, pendingOrderCount: 1, rejectedOrderCount: 3, recentConsumedCents: 1_400_000 }),
    requester({ userId: "new", spendCents: 2_000 }),
  ]

  it("lists everyone seen in any month, not only the selected one", () => {
    const union = unionCreators([june, july, august])
    expect(union.map((row) => row.userId).sort()).toEqual(["ahmed", "gone", "new"])
  })

  it("keeps the selected month's figures for those in it, and zeroes for those who are not", () => {
    const union = unionCreators([june, july, august])
    const byId = new Map(union.map((row) => [row.userId, row]))
    expect(byId.get("ahmed")).toMatchObject({
      spendCents: 2_200_000, pendingCents: 50_000, orderCount: 2, pendingOrderCount: 1, rejectedOrderCount: 3, recentConsumedCents: 1_400_000,
    })
    // Present only in June: named, but nothing of June's money leaks into the month.
    expect(byId.get("gone")).toMatchObject({
      userId: "gone", branchId: 1, role: "ORDER_PORTAL",
      spendCents: 0, pendingCents: 0, orderCount: 0, pendingOrderCount: 0, rejectedOrderCount: 0, recentConsumedCents: 0,
    })
  })

  it("resolves identity from the newest month that holds the person", () => {
    type Named = CreatorMonth & { requesterName: string }
    const older: Named[] = [{ ...requester({ userId: "x", spendCents: 5 }), requesterName: "Old Name" }]
    const newer: Named[] = [{ ...requester({ userId: "x", spendCents: 9 }), requesterName: "New Name" }]
    expect(unionCreators([older, newer])[0].requesterName).toBe("New Name")
    // And where only the older month holds them, that name is used rather than none.
    expect(unionCreators([older, []])[0].requesterName).toBe("Old Name")
  })

  it("separates the same person at two branches", () => {
    const union = unionCreators([
      [requester({ userId: "x", branchId: 1, spendCents: 5 })],
      [requester({ userId: "x", branchId: 2, spendCents: 9 })],
    ])
    expect(union).toHaveLength(2)
    expect(union.map((row) => row.branchId).sort()).toEqual([1, 2])
  })

  it("zero-fills each creator's months so every row has the same columns", () => {
    const byKey = patternByCreator(PATTERN_MONTHS, [june, july, august])
    expect(byKey.get("ahmed:1")?.map((entry) => entry.consumedCents)).toEqual([11_000, 602_000, 2_250_000])
    expect(byKey.get("gone:1")?.map((entry) => entry.consumedCents)).toEqual([900_000, 0, 0])
    expect(byKey.get("new:1")?.map((entry) => entry.consumedCents)).toEqual([0, 0, 2_000])
    expect(byKey.get("ahmed:1")?.map((entry) => entry.month)).toEqual(PATTERN_MONTHS)
    // Pending is carried beside spend, never folded away.
    expect(byKey.get("ahmed:1")?.at(-1)).toEqual({ month: "2026-08", spendCents: 2_200_000, pendingCents: 50_000, consumedCents: 2_250_000 })
  })

  it("builds an empty month and a month from a row the same way", () => {
    expect(emptyMonthConsumption("2026-08")).toEqual({ month: "2026-08", spendCents: 0, pendingCents: 0, consumedCents: 0 })
    expect(monthConsumptionOf("2026-08", { spendCents: -5, pendingCents: 10 })).toEqual({
      month: "2026-08", spendCents: 0, pendingCents: 10, consumedCents: 10,
    })
  })
})

describe("branch utilization and peer median", () => {
  it("computes utilization only for a branch with a budget", () => {
    expect(branchUtilizationPct(branch())).toBe(50)
    expect(branchUtilizationPct(branch({ totalBudgetCents: 0 }))).toBeNull()
  })

  it("returns null with too few peer branches that have a budget", () => {
    expect(peerBranchMedianUtilizationPct([])).toBeNull()
    expect(peerBranchMedianUtilizationPct([branch({ branchId: 2 })])).toBeNull()
    expect(peerBranchMedianUtilizationPct([
      branch({ branchId: 2 }),
      branch({ branchId: 3, totalBudgetCents: 0 }),
    ])).toBeNull()
  })

  it("takes the middle value, or the mean of the two middle values", () => {
    expect(peerBranchMedianUtilizationPct([
      branch({ branchId: 2, consumedCents: 30, totalBudgetCents: 100 }),
      branch({ branchId: 3, consumedCents: 10, totalBudgetCents: 100 }),
      branch({ branchId: 4, consumedCents: 20, totalBudgetCents: 100 }),
    ])).toBe(20)
    expect(peerBranchMedianUtilizationPct([
      branch({ branchId: 2, consumedCents: 10, totalBudgetCents: 100 }),
      branch({ branchId: 3, consumedCents: 30, totalBudgetCents: 100 }),
      branch({ branchId: 4, consumedCents: 40, totalBudgetCents: 100 }),
      branch({ branchId: 5, consumedCents: 100, totalBudgetCents: 100 }),
    ])).toBe(35)
  })
})

describe("the month-over-month rule", () => {
  it("compares the newest month with the one before it, and nothing else", () => {
    // The oldest month is deliberately huge: it must not enter the figure.
    expect(monthOverMonth(months(90_000_000, 1_000_000, 1_150_000)).momPct).toBeCloseTo(15)
  })

  it("flags at exactly the threshold and not a hair below", () => {
    expect(monthOverMonth(months(0, 1_000_000, 1_150_000)).momFlagged).toBe(true)
    expect(monthOverMonth(months(0, 1_000_000, 1_149_999)).momFlagged).toBe(false)
    expect(monthOverMonth(months(0, 1_000_000, 1_149_999)).momPct).toBeLessThan(T.momSpikePct)
  })

  it("reports a spike on a tiny base but never flags it", () => {
    const tiny = monthOverMonth(months(0, T.momMinBaselineCents - 1, 90_000_000))
    expect(tiny.momPct).toBeGreaterThan(1000)
    expect(tiny.momFlagged).toBe(false)
    // One cent more of baseline and the same growth does flag.
    expect(monthOverMonth(months(0, T.momMinBaselineCents, 90_000_000)).momFlagged).toBe(true)
  })

  it("calls a first month no baseline, not no change", () => {
    const first = monthOverMonth(months(0, 0, 5_000_000))
    expect(first.momPct).toBeNull()
    expect(first.momFlagged).toBe(false)
  })

  it("never flags a fall, however far it falls", () => {
    const fell = monthOverMonth(months(0, 90_000_000, 0))
    expect(fell.momPct).toBeCloseTo(-100)
    expect(fell.momFlagged).toBe(false)
  })

  it("has no baseline with fewer than two months", () => {
    expect(monthOverMonth(months(5_000_000))).toEqual({ momPct: null, momFlagged: false })
    expect(monthOverMonth([])).toEqual({ momPct: null, momFlagged: false })
  })
})

describe("signals and their guards", () => {
  const score = (row: CreatorMonth, extra: Partial<Parameters<typeof scoreRequester>[0]> = {}) =>
    scoreRequester({
      row,
      branch: branch(),
      peerBranches: ordinaryPeerBranches,
      months: months(0, 0, consumedCents(row)),
      elapsedDays: 31,
      ...extra,
    })

  it("high share needs the share, a meaningful branch total and at least two active requesters", () => {
    const row = requester({ userId: "x", spendCents: 4_500_000 })
    expect(score(row).reasons).toContain("high_share") // 45 % of 10M

    expect(score(requester({ userId: "x", spendCents: 3_900_000 })).reasons).not.toContain("high_share")
    expect(score(row, { branch: branch({ consumedCents: 1_999_999 }) }).reasons).not.toContain("high_share")
    expect(score(row, { branch: branch({ activeRequesterCount: 1 }) }).reasons).not.toContain("high_share")
    expect(score(row, { branch: branch({ activeRequesterCount: 2 }) }).reasons).toContain("high_share")
  })

  it("reports the share against the whole branch, other roles included", () => {
    const row = requester({ userId: "x", spendCents: 2_500_000 })
    expect(score(row).metrics.shareOfBranchPct).toBeCloseTo(25)
    expect(score(row, { branch: branch({ consumedCents: 0 }) }).metrics.shareOfBranchPct).toBe(0)
  })

  it("carries the whole pattern on the row, so the percentage can be checked against it", () => {
    const row = score(requester({ userId: "x", spendCents: 1_150_000 }), { months: months(11_000, 1_000_000, 1_150_000) })
    expect(row.metrics.months.map((entry) => entry.consumedCents)).toEqual([11_000, 1_000_000, 1_150_000])
    expect(row.metrics.months.map((entry) => entry.month)).toEqual(PATTERN_MONTHS)
    expect(row.metrics.momPct).toBeCloseTo(15)
    expect(row.metrics.momFlagged).toBe(true)
    expect(row.reasons).toContain("mom_spike")
    // The newest cell and the row's own month figure are the same money.
    expect(row.metrics.months.at(-1)!.consumedCents).toBe(row.metrics.consumedCents)
  })

  it("floors a negative month at zero rather than reporting a negative baseline", () => {
    const row = score(requester({ userId: "x" }), { months: months(0, -9, -5) })
    expect(row.metrics.months.map((entry) => entry.consumedCents)).toEqual([0, 0, 0])
    expect(row.metrics.momPct).toBeNull()
    expect(row.metrics.momFlagged).toBe(false)
  })

  it("above peers compares branch utilization against the other branches' median", () => {
    const peers = [
      branch({ branchId: 2, consumedCents: 10_000_000, totalBudgetCents: 10_000_000 }),
      branch({ branchId: 3, consumedCents: 10_000_000, totalBudgetCents: 10_000_000 }),
    ]
    // Peer median is 100%; 1.5× is the line.
    expect(score(requester({ userId: "x" }), { branch: branch({ consumedCents: 15_000_000, totalBudgetCents: 10_000_000 }), peerBranches: peers }).reasons).toContain("above_peers")
    expect(score(requester({ userId: "x" }), { branch: branch({ consumedCents: 14_999_999, totalBudgetCents: 10_000_000 }), peerBranches: peers }).reasons).not.toContain("above_peers")

    const lonely = score(requester({ userId: "x" }), { peerBranches: [ordinaryPeerBranches[0]] })
    expect(lonely.metrics.vsPeerPct).toBeNull()
    expect(lonely.metrics.peerBranchMedianUtilizationPct).toBeNull()
    expect(lonely.reasons).not.toContain("above_peers")
  })

  it("reports the branch and peer utilization, independent of the person being scored", () => {
    // The scored row is huge; the median of the *peers* is still 50 %.
    const row = score(requester({ userId: "x", spendCents: 50_000_000 }))
    expect(row.metrics.branchUtilizationPct).toBe(50)
    expect(row.metrics.peerBranchMedianUtilizationPct).toBe(50)
  })

  it("late surge needs a mature month, a meaningful total and half the money in the last week", () => {
    const surge = requester({ userId: "x", spendCents: 1_000_000, recentConsumedCents: 500_000 })
    expect(score(surge).reasons).toContain("late_surge")
    expect(score(surge).metrics.recentSharePct).toBeCloseTo(50)

    expect(score({ ...surge, recentConsumedCents: 499_999 }).reasons).not.toContain("late_surge")
    expect(score({ ...surge, spendCents: 499_999, recentConsumedCents: 499_999 }).reasons).not.toContain("late_surge")

    const young = score(surge, { elapsedDays: T.lateSurgeMinElapsedDays - 1 })
    expect(young.metrics.recentSharePct).toBeNull()
    expect(young.reasons).not.toContain("late_surge")
    expect(score(surge, { elapsedDays: T.lateSurgeMinElapsedDays }).reasons).toContain("late_surge")
  })

  it("high held is a share of the branch budget, or an absolute floor without one", () => {
    // 20 % of a 20M budget is 4M.
    expect(score(requester({ userId: "x", pendingCents: 4_000_000 })).reasons).toContain("high_held")
    expect(score(requester({ userId: "x", pendingCents: 3_999_999 })).reasons).not.toContain("high_held")

    const unbudgeted = branch({ totalBudgetCents: 0 })
    expect(score(requester({ userId: "x", pendingCents: T.highHeldFloorCents }), { branch: unbudgeted }).reasons).toContain("high_held")
    expect(score(requester({ userId: "x", pendingCents: T.highHeldFloorCents - 1 }), { branch: unbudgeted }).reasons).not.toContain("high_held")
    expect(score(requester({ userId: "x", pendingCents: 0 }), { branch: unbudgeted }).reasons).not.toContain("high_held")
  })

  it("rejected orders count approver rejections only, from the third", () => {
    expect(score(requester({ userId: "x", rejectedOrderCount: 2 })).reasons).not.toContain("rejected_orders")
    expect(score(requester({ userId: "x", rejectedOrderCount: 3 })).reasons).toContain("rejected_orders")
    // The count is whatever the caller measured; the pure module never sees a
    // CANCELLED order, which is the query's contract, pinned in the query tests.
  })

  it("adds the points of every reason and lists them heaviest first", () => {
    const row = score(
      requester({ userId: "x", spendCents: 5_000_000, pendingCents: 4_000_000, recentConsumedCents: 6_000_000, rejectedOrderCount: 3 }),
      {
        months: months(0, 1_000_000, 9_000_000),
        peerBranches: [
          branch({ branchId: 2, consumedCents: 1_000_000, totalBudgetCents: 10_000_000 }),
          branch({ branchId: 3, consumedCents: 2_000_000, totalBudgetCents: 10_000_000 }),
        ],
      },
    )
    expect(row.reasons).toEqual(["high_share", "mom_spike", "above_peers", "late_surge", "high_held", "rejected_orders"])
    expect(row.score).toBe(3 + 2 + 2 + 2 + 1 + 1)
    expect(isScoreFlagged(row)).toBe(true)
  })

  it("a quiet requester scores nothing", () => {
    const row = score(requester({ userId: "x", spendCents: 900_000, orderCount: 2 }))
    expect(row.score).toBe(0)
    expect(row.reasons).toEqual([])
    expect(isScoreFlagged(row)).toBe(false)
    expect(row.metrics.orderCount).toBe(2)
  })

  it("reads the retired score line exactly, for the count the response still reports", () => {
    const base = { userId: "x", branchId: 1, reasons: [], metrics: {} as never }
    expect(isScoreFlagged({ ...base, score: T.flagScore })).toBe(true)
    expect(isScoreFlagged({ ...base, score: T.flagScore - 1 })).toBe(false)
  })
})

describe("ranking and the list", () => {
  const row = (userId: string, momFlagged: boolean, momPct: number | null, consumed: number) => ({
    userId, branchId: 1, score: 0, reasons: [],
    metrics: { momFlagged, momPct, consumedCents: consumed } as never,
  })

  it("puts highlighted rows first, steepest first", () => {
    const ranked = rankWatchlist([
      row("quiet", false, 2, 900_000),
      row("spike-small", true, 400, 6_000),
      row("spike-big", true, 20, 5_000_000),
    ])
    expect(ranked.map((entry) => entry.userId)).toEqual(["spike-small", "spike-big", "quiet"])
  })

  it("orders everyone else by money, never by growth", () => {
    // Without the second term, +14 % on ₨6,000 would outrank ₨4,000,000 flat.
    const ranked = rankWatchlist([
      row("nearly", false, 14, 600_000),
      row("heavy", false, 0, 400_000_000),
    ])
    expect(ranked.map((entry) => entry.userId)).toEqual(["heavy", "nearly"])
  })

  it("keeps equal rows in a stable key order and returns a new array", () => {
    const input = [row("b", false, null, 100), row("a", false, null, 100)]
    const ranked = rankWatchlist(input)
    expect(ranked.map((entry) => entry.userId)).toEqual(["a", "b"])
    expect(ranked).not.toBe(input)
  })

  it("lists every requester, bounded by the limit, and counts them all", () => {
    const spiking = requester({ userId: "spiking", spendCents: 5_000_000 })
    const quiet = [
      requester({ userId: "p1", spendCents: 1_000_000 }),
      requester({ userId: "p2", spendCents: 1_200_000 }),
      requester({ userId: "p3", spendCents: 800_000 }),
    ]
    const { requesters, branches } = summarizeCreators([spiking, ...quiet])
    const monthsByKey = new Map([
      [creatorKey(spiking), months(0, 1_000_000, 5_000_000)],
      [creatorKey(quiet[0]), months(0, 1_000_000, 1_000_000)],
      [creatorKey(quiet[1]), months(0, 1_200_000, 1_200_000)],
      [creatorKey(quiet[2]), months(0, 800_000, 800_000)],
    ])
    const result = buildWatchlist({
      requesters, branches, patternMonths: PATTERN_MONTHS, monthsByKey, elapsedDays: 31, limit: 2,
    })

    expect(result.requesterCount).toBe(4)
    expect(result.highlightedCount).toBe(1)
    expect(result.rows).toHaveLength(2)
    // The highlight leads; the quietest of the rest is still counted but not shown.
    expect(result.rows.map((entry) => entry.userId)).toEqual(["spiking", "p2"])
    expect(result.rows[0].metrics.momPct).toBeCloseTo(400)
    expect(result.rows[0].metrics.momFlagged).toBe(true)
  })

  it("draws a requester with no pattern entry as three empty months", () => {
    const silent = requester({ userId: "silent" })
    const { requesters, branches } = summarizeCreators([silent])
    const result = buildWatchlist({
      requesters, branches, patternMonths: PATTERN_MONTHS, monthsByKey: new Map(), elapsedDays: 31, limit: 10,
    })
    expect(result.rows[0].metrics.months.map((entry) => entry.consumedCents)).toEqual([0, 0, 0])
    expect(result.rows[0].metrics.months.map((entry) => entry.month)).toEqual(PATTERN_MONTHS)
    expect(result.rows[0].metrics.momPct).toBeNull()
  })

  it("shares one branch-vs-branch peer signal across every requester at that branch", () => {
    const high = [
      requester({ userId: "n1", branchId: 1, spendCents: 9_000_000 }),
      requester({ userId: "n2", branchId: 1, spendCents: 9_000_000 }),
    ]
    const quiet = [
      requester({ userId: "s", branchId: 2, spendCents: 1_000_000 }),
      requester({ userId: "w", branchId: 3, spendCents: 2_000_000 }),
    ]
    const { requesters, branches } = summarizeCreators(
      [...high, ...quiet],
      new Map([
        [1, { totalBudgetCents: 20_000_000, remainingCents: 2_000_000 }],
        [2, { totalBudgetCents: 10_000_000, remainingCents: 9_000_000 }],
        [3, { totalBudgetCents: 10_000_000, remainingCents: 8_000_000 }],
      ]),
    )
    const result = buildWatchlist({
      requesters, branches, patternMonths: PATTERN_MONTHS,
      monthsByKey: new Map(high.map((entry) => [creatorKey(entry), months(0, 4_000_000, 9_000_000)])),
      elapsedDays: 31, limit: 10,
    })
    const northern = result.rows.filter((entry) => entry.branchId === 1)
    expect(northern.map((entry) => entry.userId).sort()).toEqual(["n1", "n2"])
    for (const entry of northern) {
      expect(entry.reasons).toContain("above_peers")
      expect(entry.metrics.branchUtilizationPct).toBe(90)
      expect(entry.metrics.peerBranchMedianUtilizationPct).toBe(15)
    }
  })

  it("scores a requester whose branch summary is missing against themselves alone", () => {
    const lone = requester({ userId: "lone", branchId: 9, spendCents: 5_000_000 })
    const result = buildWatchlist({
      requesters: [lone],
      branches: new Map(),
      patternMonths: PATTERN_MONTHS,
      monthsByKey: new Map(),
      elapsedDays: 31,
      limit: 10,
    })
    // Listed — the panel shows everyone — but with no signal and no highlight.
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].score).toBe(0)
    expect(result.rows[0].metrics.shareOfBranchPct).toBe(100)
    expect(result.requesterCount).toBe(1)
    expect(result.highlightedCount).toBe(0)
    expect(result.scoreFlaggedCount).toBe(0)
  })
})
