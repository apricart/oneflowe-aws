import { describe, expect, it } from "vitest"

import {
  MAX_BRANCH_CONTACT_PHONE,
  isValidBranchContactPhone,
  normalizeBranchContactPhone,
  parseContactPhoneInput,
} from "./branch-contact-phone"

describe("branch contact phone", () => {
  it("accepts the formats the customer sheet uses", () => {
    for (const phone of ["03323190555", "0332-3190555", "042-35453651", "+92 300 4121112", "(042) 37180463", "021 3211 6000"]) {
      expect(isValidBranchContactPhone(phone), phone).toBe(true)
    }
  })

  it("refuses letters, extensions written in words and stray symbols", () => {
    for (const phone of ["0332-319055a", "021-32116000 Ext 2110", "0300#1234567", "N/A"]) {
      expect(isValidBranchContactPhone(phone), phone).toBe(false)
    }
  })

  it("holds the digit count to 7..15", () => {
    expect(isValidBranchContactPhone("123456")).toBe(false)
    expect(isValidBranchContactPhone("1234567")).toBe(true)
    expect(isValidBranchContactPhone("123456789012345")).toBe(true)
    expect(isValidBranchContactPhone("1234567890123456")).toBe(false)
  })

  it("holds the length to the column width", () => {
    const spaced = "1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6" // 16 digits, 31 characters
    expect(spaced.length).toBeLessThanOrEqual(MAX_BRANCH_CONTACT_PHONE)
    expect(isValidBranchContactPhone(spaced)).toBe(false)
    const long = "0300-1234567 / " + "-".repeat(20)
    expect(long.length).toBeGreaterThan(MAX_BRANCH_CONTACT_PHONE)
    expect(isValidBranchContactPhone(long)).toBe(false)
  })

  it("normalises surrounding and repeated spaces", () => {
    expect(normalizeBranchContactPhone("  0300   1234567 ")).toBe("0300 1234567")
  })

  it("turns form input into the API value", () => {
    expect(parseContactPhoneInput("")).toBeNull()
    expect(parseContactPhoneInput("   ")).toBeNull()
    expect(parseContactPhoneInput(" 0300  1234567 ")).toBe("0300 1234567")
    expect(parseContactPhoneInput("call me")).toBeUndefined()
  })
})
