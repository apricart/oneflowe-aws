import { describe, expect, it } from "vitest"

import {
  MAX_BRANCH_HEAD_COUNT,
  formatBranchHeadCount,
  isHeadCountRequestStatus,
  isValidBranchHeadCount,
  parseHeadCountInput,
  statusForHeadCountDecision,
} from "@/lib/branch-head-count"

describe("isValidBranchHeadCount", () => {
  it.each([0, 1, 250, MAX_BRANCH_HEAD_COUNT])("accepts %s", (value) => {
    expect(isValidBranchHeadCount(value)).toBe(true)
  })

  it.each([-1, 1.5, MAX_BRANCH_HEAD_COUNT + 1, Number.NaN, Infinity, "12", null, undefined])(
    "refuses %s",
    (value) => {
      expect(isValidBranchHeadCount(value)).toBe(false)
    },
  )
})

describe("parseHeadCountInput", () => {
  it("reads blank as not provided", () => {
    expect(parseHeadCountInput("")).toBeNull()
    expect(parseHeadCountInput("   ")).toBeNull()
  })

  it("reads a whole number, trimmed", () => {
    expect(parseHeadCountInput(" 42 ")).toBe(42)
    expect(parseHeadCountInput("0")).toBe(0)
    expect(parseHeadCountInput(String(MAX_BRANCH_HEAD_COUNT))).toBe(MAX_BRANCH_HEAD_COUNT)
  })

  it.each(["-1", "1.5", "1e3", "12abc", "abc", String(MAX_BRANCH_HEAD_COUNT + 1)])(
    "refuses %s rather than guessing",
    (raw) => {
      expect(parseHeadCountInput(raw)).toBeUndefined()
    },
  )
})

describe("request status and decision", () => {
  it("maps each decision to its status", () => {
    expect(statusForHeadCountDecision("approve")).toBe("approved")
    expect(statusForHeadCountDecision("reject")).toBe("rejected")
  })

  it("knows the three statuses and nothing else", () => {
    expect(["pending", "approved", "rejected"].every(isHeadCountRequestStatus)).toBe(true)
    expect(isHeadCountRequestStatus("cancelled")).toBe(false)
    expect(isHeadCountRequestStatus(undefined)).toBe(false)
  })
})

describe("formatBranchHeadCount", () => {
  it("formats a figure and names the missing one", () => {
    expect(formatBranchHeadCount(1250)).toBe("1,250")
    expect(formatBranchHeadCount(0)).toBe("0")
    expect(formatBranchHeadCount(null)).toBe("Not set")
    expect(formatBranchHeadCount(undefined)).toBe("Not set")
  })
})
