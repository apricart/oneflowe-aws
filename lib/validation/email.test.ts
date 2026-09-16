import { describe, expect, it } from "vitest"

import { isRoutableEmailAddress, isValidEmailAddress, maskEmailAddress } from "@/lib/validation/email"

describe("isValidEmailAddress", () => {
  it.each(["a@b.co", "imrank@ke.com.pk", "first.last@sub.example.org"])("accepts %s", (email) => {
    expect(isValidEmailAddress(email)).toBe(true)
  })

  it.each(["", "@b.co", "a@", "a@b", "a b@c.de", "a@@b.co", "a@b."])("rejects %s", (email) => {
    expect(isValidEmailAddress(email)).toBe(false)
  })
})

describe("isRoutableEmailAddress", () => {
  it.each(["imrank@ke.com.pk", "someone@example.com"])("routes %s", (email) => {
    expect(isRoutableEmailAddress(email)).toBe(true)
  })

  it.each([
    // What the K-Electric sync derives when legacy holds no address.
    "imran.khan@ke-legacy.invalid",
    "unknown.author@historical.invalid",
    "Upper.Case@KE-LEGACY.INVALID",
    "x@invalid",
    // Not even an address.
    "",
    "not-an-email",
  ])("cannot route %s", (email) => {
    expect(isRoutableEmailAddress(email)).toBe(false)
  })

  it("does not mistake a domain that merely contains the word", () => {
    expect(isRoutableEmailAddress("a@invalid.example.com")).toBe(true)
    expect(isRoutableEmailAddress("a@notinvalid.pk")).toBe(true)
  })
})

describe("maskEmailAddress", () => {
  it("keeps the first character and the domain", () => {
    expect(maskEmailAddress("imrank@ke.com.pk")).toBe("i***@ke.com.pk")
    expect(maskEmailAddress("a@b.co")).toBe("a***@b.co")
  })

  it("gives nothing away for a value that is not an address", () => {
    expect(maskEmailAddress("")).toBe("***")
    expect(maskEmailAddress("@ke.com.pk")).toBe("***")
    expect(maskEmailAddress("nobody")).toBe("***")
  })
})
