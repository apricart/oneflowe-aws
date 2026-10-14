import { describe, expect, it } from "vitest"

import {
  APPROVAL_LEVEL_AMOUNT_FORMAT_MESSAGE,
  APPROVAL_LEVEL_AMOUNT_RANGE_MESSAGE,
  APPROVAL_LEVEL_MAX_AMOUNT_CENTS,
  APPROVAL_LEVELS_REQUIRED_MESSAGE,
  APPROVAL_LEVELS_TOO_MANY_MESSAGE,
  MAX_APPROVAL_LEVELS,
  approvalLevelAmountText,
  approvalLevelDraftErrors,
  approvalLevelDraftsError,
  approvalLevelsChanged,
  approvalLevelsError,
  formatApprovalLevelAmount,
  isApprovalLevelAmountCents,
  parseApprovalLevelAmountDraft,
  toApprovalLevels,
  toApprovalLevelsPayload,
} from "./order-approval-levels"

describe("parseApprovalLevelAmountDraft", () => {
  it.each([
    ["40000", 4_000_000],
    ["40,000", 4_000_000],
    ["40,000.5", 4_000_050],
    ["40000.50", 4_000_050],
    ["0.29", 29],
    ["0.01", 1],
    ["  80000  ", 8_000_000],
    ["1,000,000,000", APPROVAL_LEVEL_MAX_AMOUNT_CENTS],
    ["1000000000.00", APPROVAL_LEVEL_MAX_AMOUNT_CENTS],
    ["0040000", 4_000_000],
  ])("reads %j as %d cents", (text, cents) => {
    expect(parseApprovalLevelAmountDraft(text)).toEqual({ ok: true, cents })
  })

  it.each([
    "",
    "   ",
    "-1",
    "+40000",
    "abc",
    "40k",
    "1e5",
    "40000.123",
    "40000.",
    ".5",
    "40,00",
    "4,0000",
    "40 000",
    "PKR 40000",
  ])("refuses %j as malformed", (text) => {
    expect(parseApprovalLevelAmountDraft(text)).toEqual({ ok: false, message: APPROVAL_LEVEL_AMOUNT_FORMAT_MESSAGE })
  })

  it.each(["0", "0.00", "1000000000.01", "99999999999", "123456789012345678901234567890"])(
    "refuses %j as out of range",
    (text) => {
      expect(parseApprovalLevelAmountDraft(text)).toEqual({ ok: false, message: APPROVAL_LEVEL_AMOUNT_RANGE_MESSAGE })
    },
  )
})

describe("amount text", () => {
  it("formats whole and part rupees from integer cents", () => {
    expect(formatApprovalLevelAmount(4_000_000)).toBe("PKR 40,000.00")
    expect(formatApprovalLevelAmount(4_000_050)).toBe("PKR 40,000.50")
    expect(formatApprovalLevelAmount(1)).toBe("PKR 0.01")
    expect(formatApprovalLevelAmount(APPROVAL_LEVEL_MAX_AMOUNT_CENTS)).toBe("PKR 1,000,000,000.00")
  })

  it("gives the input a plain value that parses back to the same cents", () => {
    for (const cents of [1, 29, 4_000_000, 4_000_050, 12_345_678, APPROVAL_LEVEL_MAX_AMOUNT_CENTS]) {
      const text = approvalLevelAmountText(cents)
      expect(text).not.toContain(",")
      expect(parseApprovalLevelAmountDraft(text)).toEqual({ ok: true, cents })
    }
    expect(approvalLevelAmountText(4_000_000)).toBe("40000")
    expect(approvalLevelAmountText(4_000_050)).toBe("40000.50")
  })
})

describe("isApprovalLevelAmountCents", () => {
  it("accepts integer cents inside the bounds only", () => {
    expect(isApprovalLevelAmountCents(1)).toBe(true)
    expect(isApprovalLevelAmountCents(APPROVAL_LEVEL_MAX_AMOUNT_CENTS)).toBe(true)
    expect(isApprovalLevelAmountCents(0)).toBe(false)
    expect(isApprovalLevelAmountCents(-1)).toBe(false)
    expect(isApprovalLevelAmountCents(APPROVAL_LEVEL_MAX_AMOUNT_CENTS + 1)).toBe(false)
    expect(isApprovalLevelAmountCents(1.5)).toBe(false)
    expect(isApprovalLevelAmountCents(Number.NaN)).toBe(false)
    expect(isApprovalLevelAmountCents("400")).toBe(false)
  })
})

describe("approvalLevelsError", () => {
  it("accepts strictly increasing amounts", () => {
    expect(approvalLevelsError(true, [4_000_000])).toBeNull()
    expect(approvalLevelsError(true, [4_000_000, 8_000_000, 8_000_001])).toBeNull()
  })

  it("requires a level when switched on, and none when switched off", () => {
    expect(approvalLevelsError(true, [])).toBe(APPROVAL_LEVELS_REQUIRED_MESSAGE)
    expect(approvalLevelsError(false, [])).toBeNull()
  })

  it("refuses an amount no higher than the level before it, equal included", () => {
    expect(approvalLevelsError(true, [8_000_000, 4_000_000])).toBe(
      "Level 2's amount must be higher than Level 1's (PKR 80,000.00).",
    )
    expect(approvalLevelsError(true, [4_000_000, 4_000_000])).toBe(
      "Level 2's amount must be higher than Level 1's (PKR 40,000.00).",
    )
    expect(approvalLevelsError(false, [4_000_000, 8_000_000, 6_000_000])).toContain("Level 3's amount")
  })

  it("refuses an amount outside the bounds", () => {
    expect(approvalLevelsError(true, [0])).toBe(`Level 1: ${APPROVAL_LEVEL_AMOUNT_RANGE_MESSAGE}`)
    expect(approvalLevelsError(true, [100, APPROVAL_LEVEL_MAX_AMOUNT_CENTS + 1])).toBe(
      `Level 2: ${APPROVAL_LEVEL_AMOUNT_RANGE_MESSAGE}`,
    )
    expect(approvalLevelsError(true, [12.5])).toBe(`Level 1: ${APPROVAL_LEVEL_AMOUNT_RANGE_MESSAGE}`)
  })

  it("allows exactly the maximum number of levels and not one more", () => {
    const amounts = (count: number) => Array.from({ length: count }, (_, index) => (index + 1) * 100)
    expect(approvalLevelsError(true, amounts(MAX_APPROVAL_LEVELS))).toBeNull()
    expect(approvalLevelsError(true, amounts(MAX_APPROVAL_LEVELS + 1))).toBe(APPROVAL_LEVELS_TOO_MANY_MESSAGE)
  })
})

describe("toApprovalLevels", () => {
  it("numbers levels from their position, starting at 1", () => {
    expect(toApprovalLevels([4_000_000, 8_000_000])).toEqual([
      { level: 1, maxAmountCents: 4_000_000 },
      { level: 2, maxAmountCents: 8_000_000 },
    ])
    expect(toApprovalLevels([])).toEqual([])
  })
})

describe("approvalLevelsChanged", () => {
  const current = { enabled: true, levels: toApprovalLevels([4_000_000, 8_000_000]) }

  it("is false for the same state", () => {
    expect(approvalLevelsChanged(current, { enabled: true, amountsCents: [4_000_000, 8_000_000] })).toBe(false)
  })

  it("is false when the levels are left alone and the switch is unchanged", () => {
    expect(approvalLevelsChanged({ ...current, enabled: false }, { enabled: false })).toBe(false)
  })

  it("is true for a switch flip, an amount change, an added or a removed level", () => {
    expect(approvalLevelsChanged(current, { enabled: false })).toBe(true)
    expect(approvalLevelsChanged(current, { enabled: true, amountsCents: [4_000_000, 9_000_000] })).toBe(true)
    expect(approvalLevelsChanged(current, { enabled: true, amountsCents: [4_000_000, 8_000_000, 9_000_000] })).toBe(true)
    expect(approvalLevelsChanged(current, { enabled: true, amountsCents: [4_000_000] })).toBe(true)
  })
})

describe("the form's drafts", () => {
  it("reports each level's own problem, then its order against the level before", () => {
    expect(approvalLevelDraftErrors(["40000", "80000"])).toEqual([null, null])
    expect(approvalLevelDraftErrors(["40000", ""])).toEqual([null, APPROVAL_LEVEL_AMOUNT_FORMAT_MESSAGE])
    expect(approvalLevelDraftErrors(["80000", "40000"])).toEqual([
      null,
      "Level 2's amount must be higher than Level 1's (PKR 80,000.00).",
    ])
    // A level after one that does not parse is judged on its own text only.
    expect(approvalLevelDraftErrors(["abc", "40000"])).toEqual([APPROVAL_LEVEL_AMOUNT_FORMAT_MESSAGE, null])
  })

  it("blocks saving only while switched on", () => {
    expect(approvalLevelDraftsError(false, [])).toBeNull()
    expect(approvalLevelDraftsError(false, ["garbage"])).toBeNull()
    expect(approvalLevelDraftsError(true, [])).toBe(APPROVAL_LEVELS_REQUIRED_MESSAGE)
    expect(approvalLevelDraftsError(true, ["40000", "30000"])).toBe("Fix the approval level amounts before saving.")
    expect(approvalLevelDraftsError(true, ["40000", "80,000"])).toBeNull()
    expect(approvalLevelDraftsError(true, Array.from({ length: MAX_APPROVAL_LEVELS + 1 }, (_, i) => String(i + 1))))
      .toBe(APPROVAL_LEVELS_TOO_MANY_MESSAGE)
  })

  it("sends cents while switched on, and omits the levels while switched off", () => {
    expect(toApprovalLevelsPayload(true, ["40,000", "80000.50"])).toEqual({
      enabled: true,
      levels: [{ maxAmountCents: 4_000_000 }, { maxAmountCents: 8_000_050 }],
    })
    expect(toApprovalLevelsPayload(false, ["40,000"])).toEqual({ enabled: false })
    expect(() => toApprovalLevelsPayload(true, ["nope"])).toThrow()
  })
})
